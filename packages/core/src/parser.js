import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { fail } from "./errors.js"
import { sha256 } from "./utils.js"
import { xlsxToMarkdown } from "./xlsx.js"

export const SUPPORTED_SOURCE_TYPES = Object.freeze({
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
})

export async function parseManagedSource(filePath, sourceId, mediaType, options = {}) {
  let content
  let tableMetadata = []
  let documentMetadata = {}
  try {
    if (mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const parsed = await docxToMarkdown(await readFile(filePath))
      content = parsed.markdown
      tableMetadata = parsed.tables
    } else if (mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      const parsed = await xlsxToMarkdown(await readFile(filePath), {
        fileName: path.basename(filePath),
        maxTableChars: Math.max(1_000, (options.maxChunkChars ?? 8_000) - 500),
      })
      content = parsed.markdown
      tableMetadata = parsed.tables
      documentMetadata = parsed.metadata
    } else if (mediaType === "application/pdf") {
      content = await pdfToMarkdown(await readFile(filePath))
    } else {
      content = await readFile(filePath, "utf8")
      if (mediaType === "text/html") content = htmlToMarkdown(content)
    }
  } catch (error) {
    fail("SOURCE_PARSE_FAILED", `Could not decode ${path.basename(filePath)} as UTF-8 text.`, {
      details: { reason: error instanceof Error ? error.message : String(error) },
    })
  }
  if (content.includes("\0")) {
    fail("SOURCE_PARSE_FAILED", "The source appears to be binary rather than Markdown or text.")
  }
  const normalized = content.replace(/\r\n?/g, "\n")
  if (!normalized.trim()) fail("SOURCE_PARSE_FAILED", "The source document contains no usable text.")
  const blocks = parseBlocks(normalized)
  if (tableMetadata.length > 0) {
    let tableIndex = 0
    for (const block of blocks) {
      if (block.kind !== "table") continue
      const metadata = tableMetadata[tableIndex++] ?? {}
      const { markdown: _markdown, ...structuredMetadata } = metadata
      Object.assign(block, structuredMetadata)
    }
  }
  const document = {
    sourceId,
    title: inferTitle(normalized, path.basename(filePath)),
    mediaType,
    metadata: documentMetadata,
    blocks,
    media: [],
  }
  const chunks = chunkDocument(document, {
    maxChars: options.maxChunkChars ?? 8_000,
  })
  for (const chunk of chunks) {
    const pageHeading = [...chunk.headingPath].reverse().find((heading) => /^Page \d+$/i.test(heading))
    if (pageHeading) chunk.pageNumber = Number(pageHeading.match(/\d+/)?.[0])
  }
  return { document, markdown: normalized, chunks }
}

async function docxToMarkdown(buffer) {
  let zip
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true })
  } catch {
    fail("SOURCE_PARSE_FAILED", "The DOCX archive is invalid or corrupt.")
  }
  const entries = Object.values(zip.files)
  if (entries.length > 2_000) fail("SOURCE_PARSE_FAILED", "The DOCX archive contains too many entries.")
  const declaredBytes = entries.reduce((sum, entry) => sum + Number(entry?._data?.uncompressedSize ?? 0), 0)
  if (declaredBytes > 100 * 1024 * 1024) fail("SOURCE_PARSE_FAILED", "The DOCX archive expands beyond the safe parsing limit.")
  const documentFile = zip.file("word/document.xml")
  if (!documentFile) fail("SOURCE_PARSE_FAILED", "The DOCX file has no word/document.xml part.")
  const xml = await documentFile.async("string")
  if (Buffer.byteLength(xml) > 50 * 1024 * 1024) fail("SOURCE_PARSE_FAILED", "The DOCX document XML exceeds the safe parsing limit.")
  const body = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)?.[1] ?? xml
  const units = [...body.matchAll(/<w:(p|tbl)\b[\s\S]*?<\/w:\1>/g)].map((match) => match[0])
  const markdown = []
  const tables = []
  for (const unit of units) {
    if (unit.startsWith("<w:tbl")) {
      const table = parseDocxTable(unit)
      tables.push(table)
      markdown.push(table.markdown)
      continue
    }
    const text = wordText(unit)
    if (!text) continue
    const style = unit.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1] ?? ""
    const heading = style.match(/heading\s*([1-6])/i)?.[1]
    markdown.push(heading ? `${"#".repeat(Number(heading))} ${text}` : text)
  }
  return { markdown: markdown.join("\n\n"), tables }
}

function parseDocxTable(xml) {
  const rows = []
  const mergedCells = []
  const rowXml = xml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []
  rowXml.forEach((row, rowIndex) => {
    const cells = []
    const cellXml = row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []
    cellXml.forEach((cell, cellIndex) => {
      cells.push(wordText(cell).replace(/\|/g, "\\|") || " ")
      const columnSpan = Number(cell.match(/<w:gridSpan\b[^>]*w:val="(\d+)"/)?.[1] ?? 1)
      const merge = cell.match(/<w:vMerge\b([^>]*)\/?\s*>/)?.[1]
      if (columnSpan > 1 || merge !== undefined) {
        mergedCells.push({
          row: rowIndex,
          column: cellIndex,
          columnSpan,
          ...(merge !== undefined ? { verticalMerge: merge.includes("restart") ? "restart" : "continue" } : {}),
        })
      }
    })
    rows.push(cells)
  })
  const width = Math.max(1, ...rows.map((row) => row.length))
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill(" ")])
  if (normalized.length === 0) normalized.push(Array(width).fill(" "))
  const delimiter = Array(width).fill("---")
  const markdownRows = [normalized[0], delimiter, ...normalized.slice(1)]
  return { mergedCells, markdown: markdownRows.map((row) => `| ${row.join(" | ")} |`).join("\n") }
}

function wordText(xml) {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(tab|br)\b[^>]*\/?\s*>/g)]
    .map((match) => match[2] === "tab" ? "\t" : match[2] === "br" ? "\n" : decodeXml(match[1]))
    .join("")
    .trim()
}

function htmlToMarkdown(html) {
  let value = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, "")
  value = value.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_all, table) => htmlTableToMarkdown(table))
  value = value.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level, inner) => `\n\n${"#".repeat(Number(level))} ${stripHtml(inner)}\n\n`)
  value = value.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_all, inner) => `\n- ${stripHtml(inner)}`)
  value = value.replace(/<(p|div|section|article|header|footer|blockquote)\b[^>]*>/gi, "\n\n")
  value = value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "")
  return decodeXml(value).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

function htmlTableToMarkdown(table) {
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => stripHtml(cell[1]).replace(/\|/g, "\\|")),
  ).filter((row) => row.length > 0)
  if (rows.length === 0) return ""
  const width = Math.max(...rows.map((row) => row.length))
  const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill(" ")])
  return `\n\n${[normalized[0], Array(width).fill("---"), ...normalized.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n")}\n\n`
}

function stripHtml(value) {
  return decodeXml(value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
}

function decodeXml(value = "") {
  return value.replace(/&#(x?[0-9a-f]+);|&([a-z]+);/gi, (_all, numeric, named) => {
    if (numeric) return String.fromCodePoint(Number.parseInt(numeric.replace(/^x/i, ""), numeric.startsWith("x") ? 16 : 10))
    return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " })[named.toLowerCase()] ?? _all
  })
}

async function pdfToMarkdown(buffer) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const standardFontDataUrl = fileURLToPath(new URL("./standard_fonts/", import.meta.resolve("pdfjs-dist/package.json")))
    const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, isEvalSupported: false, disableFontFace: true, standardFontDataUrl }).promise
    const pages = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const text = await page.getTextContent()
      let line = ""
      const lines = []
      for (const item of text.items) {
        if (!("str" in item)) continue
        line += item.str
        if (item.hasEOL) {
          if (line.trim()) lines.push(line.trim())
          line = ""
        } else line += " "
      }
      if (line.trim()) lines.push(line.trim())
      pages.push(`# Page ${pageNumber}\n\n${lines.join("\n")}`)
    }
    await document.destroy()
    return pages.join("\n\n")
  } catch (error) {
    fail("SOURCE_PARSE_FAILED", "The PDF could not be safely parsed.", { details: { reason: error instanceof Error ? error.message : String(error) } })
  }
}

function inferTitle(content, fallback) {
  const heading = content.match(/^#\s+(.+)$/m)
  return heading?.[1]?.trim() || fallback.replace(/\.(md|markdown|txt)$/i, "")
}

function parseBlocks(content) {
  const lines = content.split("\n")
  const blocks = []
  let index = 0
  let offset = 0
  let paragraph = []
  let paragraphStart = 0

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const text = paragraph.join("\n").trim()
    if (text) blocks.push({ kind: "paragraph", text, startOffset: paragraphStart, endOffset: paragraphStart + text.length })
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index]
    const lineStart = offset
    const lineBytes = line.length + (index < lines.length - 1 ? 1 : 0)

    const fence = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      flushParagraph()
      const marker = fence[1][0]
      const collected = [line]
      let end = lineStart + lineBytes
      index += 1
      offset += lineBytes
      while (index < lines.length) {
        const next = lines[index]
        const size = next.length + (index < lines.length - 1 ? 1 : 0)
        collected.push(next)
        end = offset + size
        index += 1
        offset += size
        if (new RegExp(`^\\s*${marker}{3,}\\s*$`).test(next)) break
      }
      blocks.push({ kind: "code", text: collected.join("\n"), startOffset: lineStart, endOffset: end })
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (heading) {
      flushParagraph()
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2], startOffset: lineStart, endOffset: lineStart + line.length })
      index += 1
      offset += lineBytes
      continue
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph()
      const tableLines = []
      const start = lineStart
      let end = start
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        const next = lines[index]
        const size = next.length + (index < lines.length - 1 ? 1 : 0)
        tableLines.push(next)
        end = offset + size
        index += 1
        offset += size
      }
      const rows = tableLines.map(parseMarkdownTableRow)
      const hasDelimiter = rows[1]?.every((cell) => /^:?-{3,}:?$/.test(cell)) ?? false
      blocks.push({
        kind: "table",
        headers: hasDelimiter ? rows[0] : [],
        rows: hasDelimiter ? rows.slice(2) : rows,
        markdown: tableLines.join("\n"),
        text: tableLines.join("\n"),
        startOffset: start,
        endOffset: end,
      })
      continue
    }

    if (!line.trim()) {
      flushParagraph()
    } else {
      if (paragraph.length === 0) paragraphStart = lineStart
      paragraph.push(line)
    }
    index += 1
    offset += lineBytes
  }
  flushParagraph()
  return blocks
}

function parseMarkdownTableRow(row) {
  const value = row.trim().slice(1, -1)
  const cells = []
  let cell = ""
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === "\\" && value[index + 1] === "|") {
      cell += "|"
      index += 1
    } else if (character === "|") {
      cells.push(cell.trim())
      cell = ""
    } else cell += character
  }
  cells.push(cell.trim())
  return cells
}

function chunkDocument(document, options) {
  const maxChars = Math.max(500, options.maxChars)
  const headings = {}
  const chunks = []
  let pending = []
  let pendingKinds = []
  let pendingStart
  let pendingEnd

  const headingPath = () => Object.keys(headings)
    .map(Number)
    .sort((a, b) => a - b)
    .map((level) => headings[level])

  const emit = () => {
    const text = pending.join("\n\n").trim()
    if (!text) return
    const ordinal = chunks.length
    chunks.push({
      chunkId: `chunk-${sha256(`${document.sourceId}:${ordinal}:${text}`).slice(0, 24)}`,
      sourceId: document.sourceId,
      ordinal,
      headingPath: headingPath(),
      blockKinds: [...new Set(pendingKinds)],
      text,
      ...(pendingKinds.includes("table") ? { structuredData: document.blocks.filter((block) => block.kind === "table" && text.includes(block.markdown)) } : {}),
      startOffset: pendingStart,
      endOffset: pendingEnd,
      tokenEstimate: Math.ceil(text.length / 4),
      contentHash: sha256(text),
    })
    const structured = chunks.at(-1).structuredData ?? []
    const sheetNames = [...new Set(structured.map((table) => table.sheetName).filter(Boolean))]
    const cellRanges = [...new Set(structured.map((table) => table.cellRange).filter(Boolean))]
    if (sheetNames.length === 1) chunks.at(-1).sheetName = sheetNames[0]
    if (cellRanges.length === 1) chunks.at(-1).cellRange = cellRanges[0]
    pending = []
    pendingKinds = []
    pendingStart = undefined
    pendingEnd = undefined
  }

  for (const block of document.blocks) {
    if (block.kind === "heading") {
      emit()
      headings[block.level] = block.text
      for (let level = block.level + 1; level <= 6; level += 1) delete headings[level]
      pending.push(`${"#".repeat(block.level)} ${block.text}`)
      pendingKinds.push(block.kind)
      pendingStart = block.startOffset
      pendingEnd = block.endOffset
      continue
    }
    const text = block.text || block.markdown || ""
    if (pending.length > 0 && pending.join("\n\n").length + text.length + 2 > maxChars) emit()
    if (text.length > maxChars && !["code", "table"].includes(block.kind)) {
      const pieces = splitText(text, maxChars)
      for (const piece of pieces) {
        pending = [piece]
        pendingKinds = [block.kind]
        pendingStart = block.startOffset
        pendingEnd = block.endOffset
        emit()
      }
      continue
    }
    if (pendingStart === undefined) pendingStart = block.startOffset
    pending.push(text)
    pendingKinds.push(block.kind)
    pendingEnd = block.endOffset
  }
  emit()
  return chunks
}

function splitText(text, maxChars) {
  const result = []
  let rest = text
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1)
    const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf(". "), window.lastIndexOf(" ")]
    const cut = Math.max(...candidates, Math.floor(maxChars * 0.6))
    result.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.trim()) result.push(rest.trim())
  return result
}
