import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { LlmWikiError, fail } from "./errors.js"
import { createOcrSession } from "./ocr.js"
import { pptxToMarkdown } from "./pptx.js"
import { safeTextCut, sha256 } from "./utils.js"
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
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
})

export async function parseManagedSource(filePath, sourceId, mediaType, options = {}) {
  options.signal?.throwIfAborted()
  let content
  let tableMetadata = []
  let documentMetadata = {}
  let media = []
  const ownsOcrSession = !options.ocrSession
  const ocrSession = options.ocrSession ?? createOcrSession({
    languages: options.ocrLanguages,
    recognize: options.ocrRecognize,
  })
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
      const parsed = await pdfToMarkdown(await readFile(filePath), { ocrSession, signal: options.signal })
      content = parsed.markdown
      documentMetadata = parsed.metadata
    } else if (mediaType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      || mediaType === "application/vnd.ms-powerpoint.presentation.macroEnabled.12") {
      const parsed = await pptxToMarkdown(await readFile(filePath), {
        fileName: path.basename(filePath),
        ocrSession,
        maxOcrImages: options.maxOcrImages,
        signal: options.signal,
      })
      content = parsed.markdown
      documentMetadata = parsed.metadata
    } else if (mediaType.startsWith("image/")) {
      const imageBuffer = await readFile(filePath)
      if (!options.ocrRecognize) await assertSafeImageDimensions(imageBuffer)
      options.signal?.throwIfAborted()
      const recognized = await ocrSession.recognize(imageBuffer, {
        kind: "source-image",
        imageName: path.basename(filePath),
        signal: options.signal,
      })
      if (!recognized.text) fail("SOURCE_PARSE_FAILED", "OCR found no usable text in the source image.")
      const imageTitle = path.basename(filePath, path.extname(filePath)) || "Image"
      content = `# ${imageTitle}\n\n## OCR text\n\n${recognized.text}`
      documentMetadata = {
        imageType: mediaType,
        extractionMethod: "ocr",
        ocrLanguages: ocrSession.languages,
        textCharacters: recognized.text.length,
        ...(recognized.confidence !== undefined ? { confidence: recognized.confidence } : {}),
      }
      media = [{ kind: "image", mediaType, extractionMethod: "ocr" }]
    } else {
      content = await readFile(filePath, "utf8")
      if (mediaType === "text/html") content = htmlToMarkdown(content)
    }
  } catch (error) {
    if (error instanceof LlmWikiError) throw error
    fail("SOURCE_PARSE_FAILED", `Could not safely parse ${path.basename(filePath)}.`, {
      details: { reason: error instanceof Error ? error.message : String(error) },
    })
  } finally {
    if (ownsOcrSession) await ocrSession.terminate()
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
    media,
  }
  const chunks = chunkDocument(document, {
    maxChars: options.maxChunkChars ?? 8_000,
  })
  for (const chunk of chunks) {
    const pageHeading = [...chunk.headingPath].reverse().find((heading) => /^Page \d+$/i.test(heading))
    if (pageHeading) chunk.pageNumber = Number(pageHeading.match(/\d+/)?.[0])
    const slideHeading = [...chunk.headingPath].reverse().find((heading) => /^Slide \d+$/i.test(heading))
    if (slideHeading) chunk.slideNumber = Number(slideHeading.match(/\d+/)?.[0])
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

async function pdfToMarkdown(buffer, options) {
  let loadingTask
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const standardFontDataUrl = fileURLToPath(new URL("./standard_fonts/", import.meta.resolve("pdfjs-dist/package.json")))
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      // PDF imports are text extraction only. Never execute document-level
      // JavaScript even if a future PDF.js default changes.
      enableScripting: false,
      isEvalSupported: false,
      disableFontFace: true,
      standardFontDataUrl,
    })
    const document = await loadingTask.promise
    const pages = []
    const ocrPages = []
    const textPages = []
    let usableTextCharacters = 0
    const maxPages = 2_000
    const maxOcrPages = 500
    const maxOcrCharacters = 5_000_000
    const deadline = Date.now() + 30 * 60 * 1_000
    if (document.numPages > maxPages) fail("SOURCE_PARSE_FAILED", `The PDF exceeds the ${maxPages}-page safety limit.`)
    let ocrCharacters = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      options.signal?.throwIfAborted()
      if (Date.now() > deadline) fail("SOURCE_PARSE_FAILED", "PDF parsing exceeded the 30-minute safety budget.")
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
      let pageText = lines.join("\n").trim()
      if (searchableCharacterCount(pageText) < 8) {
        if (ocrPages.length >= maxOcrPages) fail("SOURCE_PARSE_FAILED", `The PDF exceeds the ${maxOcrPages}-page OCR safety limit.`)
        const image = await renderPdfPage(page)
        options.signal?.throwIfAborted()
        const recognized = await options.ocrSession.recognize(image, { kind: "pdf-page", pageNumber, signal: options.signal })
        if (recognized.text) {
          ocrCharacters += recognized.text.length
          if (ocrCharacters > maxOcrCharacters) fail("SOURCE_PARSE_FAILED", "PDF OCR text exceeds the safety limit.")
          pageText = pageText && !recognized.text.includes(pageText)
            ? `${pageText}\n${recognized.text}`
            : recognized.text
          ocrPages.push({
            pageNumber,
            textCharacters: recognized.text.length,
            ...(recognized.confidence !== undefined ? { confidence: recognized.confidence } : {}),
          })
        } else if (pageText) textPages.push(pageNumber)
      } else textPages.push(pageNumber)
      usableTextCharacters += pageText.length
      pages.push(`# Page ${pageNumber}\n\n${pageText || "_No readable text detected._"}`)
    }
    if (usableTextCharacters === 0) fail("SOURCE_PARSE_FAILED", "The PDF contains no usable native or OCR text.")
    return {
      markdown: pages.join("\n\n"),
      metadata: {
        pdfPageCount: document.numPages,
        textPages,
        ocrPages,
        ocrLanguages: options.ocrSession.languages,
        scriptingEnabled: false,
      },
    }
  } catch (error) {
    if (error instanceof LlmWikiError) throw error
    fail("SOURCE_PARSE_FAILED", "The PDF could not be safely parsed.", { details: { reason: error instanceof Error ? error.message : String(error) } })
  } finally {
    // PDF.js 6 moved destruction to the LoadingTask. Keeping lifecycle
    // ownership here prevents a successful extraction from being converted
    // into SOURCE_PARSE_FAILED by a version-specific cleanup call.
    await loadingTask?.destroy().catch(() => {})
  }
}

async function renderPdfPage(page) {
  const { createCanvas } = await import("@napi-rs/canvas")
  const base = page.getViewport({ scale: 1 })
  const maxPixels = 16_000_000
  const scale = Math.min(2, Math.sqrt(maxPixels / Math.max(1, base.width * base.height)))
  const viewport = page.getViewport({ scale })
  const width = Math.max(1, Math.ceil(viewport.width))
  const height = Math.max(1, Math.ceil(viewport.height))
  if (width * height > maxPixels) fail("SOURCE_PARSE_FAILED", "Rendered PDF page exceeds the pixel safety limit.")
  const canvas = createCanvas(width, height)
  const canvasContext = canvas.getContext("2d")
  await page.render({ canvas, canvasContext, viewport, intent: "display" }).promise
  return canvas.toBuffer("image/png")
}

async function assertSafeImageDimensions(buffer) {
  const header = imageHeaderDimensions(buffer)
  validateDecodedImageBounds(header.width, header.height, header.frames)
  const { loadImage } = await import("@napi-rs/canvas")
  let image
  try {
    image = await loadImage(buffer)
  } catch {
    fail("SOURCE_PARSE_FAILED", "The image could not be safely decoded.")
  }
  const width = Number(image.width)
  const height = Number(image.height)
  if (width !== header.width || height !== header.height) fail("SOURCE_PARSE_FAILED", "The decoded image dimensions do not match its header.")
  validateDecodedImageBounds(width, height, header.frames)
}

function validateDecodedImageBounds(width, height, frames = 1) {
  const maxDimension = 20_000
  const maxPixels = 40_000_000
  const maxDecodedBytes = 160_000_000
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1
    || !Number.isSafeInteger(width * height) || width > maxDimension || height > maxDimension
    || width * height > maxPixels || width * height * 4 > maxDecodedBytes || frames !== 1) {
    fail("SOURCE_PARSE_FAILED", "The image exceeds the dimension or decoded-pixel safety limit.")
  }
}

function imageHeaderDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) fail("SOURCE_PARSE_FAILED", "The image header is incomplete.")
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") fail("SOURCE_PARSE_FAILED", "The PNG header is invalid.")
    const animationOffset = buffer.indexOf(Buffer.from("acTL"))
    const frames = animationOffset >= 4 && animationOffset + 8 <= buffer.length ? buffer.readUInt32BE(animationOffset + 4) : 1
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), frames }
  }
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return jpegHeaderDimensions(buffer)
  if (buffer.toString("ascii", 0, 2) === "BM" && buffer.length >= 26) {
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)), frames: 1 }
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return webpHeaderDimensions(buffer)
  if (["II", "MM"].includes(buffer.toString("ascii", 0, 2))) return tiffHeaderDimensions(buffer)
  fail("SOURCE_PARSE_FAILED", "The image format header is unsupported or corrupt.")
}

function jpegHeaderDimensions(buffer) {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xFF) { offset += 1; continue }
    const marker = buffer[offset + 1]
    offset += 2
    if (marker === 0xD8 || marker === 0xD9) continue
    if (offset + 2 > buffer.length) break
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) break
    if ([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3), frames: 1 }
    }
    offset += length
  }
  fail("SOURCE_PARSE_FAILED", "The JPEG dimensions are missing or corrupt.")
}

function webpHeaderDimensions(buffer) {
  const kind = buffer.toString("ascii", 12, 16)
  if (kind === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
      frames: (buffer[20] & 0x02) === 0 ? 1 : 2,
    }
  }
  if (kind === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9D && buffer[24] === 0x01 && buffer[25] === 0x2A) {
    return { width: buffer.readUInt16LE(26) & 0x3FFF, height: buffer.readUInt16LE(28) & 0x3FFF, frames: 1 }
  }
  if (kind === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2F) {
    const bits = buffer.readUInt32LE(21)
    return { width: 1 + (bits & 0x3FFF), height: 1 + ((bits >>> 14) & 0x3FFF), frames: 1 }
  }
  fail("SOURCE_PARSE_FAILED", "The WebP dimensions are missing or corrupt.")
}

function tiffHeaderDimensions(buffer) {
  const littleEndian = buffer.toString("ascii", 0, 2) === "II"
  const read16 = (offset) => littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
  const read32 = (offset) => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  if (buffer.length < 8 || read16(2) !== 42) fail("SOURCE_PARSE_FAILED", "The TIFF header is invalid.")
  const ifdOffset = read32(4)
  if (ifdOffset < 8 || ifdOffset + 2 > buffer.length) fail("SOURCE_PARSE_FAILED", "The TIFF directory is invalid.")
  const count = read16(ifdOffset)
  if (count > 4_096 || ifdOffset + 2 + count * 12 + 4 > buffer.length) fail("SOURCE_PARSE_FAILED", "The TIFF directory exceeds safety limits.")
  let width
  let height
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12
    const tag = read16(entry)
    if (tag !== 256 && tag !== 257) continue
    const type = read16(entry + 2)
    const itemCount = read32(entry + 4)
    if (itemCount !== 1 || ![3, 4].includes(type)) fail("SOURCE_PARSE_FAILED", "The TIFF dimension entry is invalid.")
    const value = type === 3 ? read16(entry + 8) : read32(entry + 8)
    if (tag === 256) width = value
    else height = value
  }
  const nextIfd = read32(ifdOffset + 2 + count * 12)
  if (!width || !height) fail("SOURCE_PARSE_FAILED", "The TIFF dimensions are missing.")
  return { width, height, frames: nextIfd === 0 ? 1 : 2 }
}

function searchableCharacterCount(value) {
  return (String(value).match(/[\p{L}\p{N}]/gu) ?? []).length
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
    const rawText = paragraph.join("\n")
    const text = rawText.trim()
    if (text) {
      const leading = rawText.length - rawText.trimStart().length
      blocks.push({
        kind: "paragraph",
        text,
        startOffset: paragraphStart + leading,
        endOffset: paragraphStart + leading + text.length,
      })
    }
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
  let pendingStructured = []
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
      ...(pendingStructured.length > 0 ? { structuredData: pendingStructured } : {}),
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
    pendingStructured = []
    pendingStart = undefined
    pendingEnd = undefined
  }

  for (const block of document.blocks) {
    if (block.kind === "heading") {
      emit()
      headings[block.level] = block.text.slice(0, 500)
      for (let level = block.level + 1; level <= 6; level += 1) delete headings[level]
      const rendered = `${"#".repeat(block.level)} ${block.text}`
      for (const piece of splitText(rendered, maxChars)) {
        pending = [piece]
        pendingKinds = [block.kind]
        pendingStart = block.startOffset
        pendingEnd = block.endOffset
        if (rendered.length > maxChars) emit()
      }
      continue
    }
    const text = block.text || block.markdown || ""
    if (pending.length > 0 && pending.join("\n\n").length + text.length + 2 > maxChars) emit()
    if (text.length > maxChars) {
      const pieces = splitTextWithOffsets(text, maxChars)
      for (const piece of pieces) {
        pending = [piece.text]
        pendingKinds = [block.kind]
        pendingStructured = block.kind === "table" ? [tableFragment(block, piece.text)] : []
        pendingStart = block.startOffset + piece.relativeStart
        pendingEnd = block.startOffset + piece.relativeEnd
        emit()
      }
      continue
    }
    if (pendingStart === undefined) pendingStart = block.startOffset
    pending.push(text)
    pendingKinds.push(block.kind)
    if (block.kind === "table") pendingStructured.push(block)
    pendingEnd = block.endOffset
  }
  emit()
  return chunks
}

function tableFragment(block, markdown) {
  return {
    kind: "table",
    markdown,
    text: markdown,
    fragmented: true,
    ...(block.sheetName ? { sheetName: block.sheetName } : {}),
    ...(block.cellRange ? { cellRange: block.cellRange } : {}),
    ...(block.sheetState ? { sheetState: block.sheetState } : {}),
  }
}

function splitText(text, maxChars) {
  return splitTextWithOffsets(text, maxChars).map((piece) => piece.text)
}

function splitTextWithOffsets(text, maxChars) {
  const result = []
  let cursor = 0
  const overlapChars = Math.max(1, Math.floor(maxChars * 0.12))
  while (text.length - cursor > maxChars) {
    const window = text.slice(cursor, cursor + maxChars + 1)
    const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf(". "), window.lastIndexOf(" ")]
    const cut = Math.max(...candidates, Math.max(1, Math.floor(maxChars * 0.6)))
    const rawEnd = safeTextCut(text, cursor + cut, cursor)
    const rawPiece = text.slice(cursor, rawEnd)
    const piece = rawPiece.trim()
    if (piece) {
      const leading = rawPiece.length - rawPiece.trimStart().length
      const trailing = rawPiece.length - rawPiece.trimEnd().length
      result.push({
        text: piece,
        relativeStart: cursor + leading,
        relativeEnd: rawEnd - trailing,
      })
    }
    const nextStart = Math.max(cursor + 1, rawEnd - overlapChars)
    const safeStart = safeTextCut(text, nextStart, cursor)
    const remainder = text.slice(safeStart)
    cursor = safeStart + (remainder.length - remainder.trimStart().length)
  }
  const rawRemainder = text.slice(cursor)
  const remainder = rawRemainder.trim()
  if (remainder) {
    const leading = rawRemainder.length - rawRemainder.trimStart().length
    const trailing = rawRemainder.length - rawRemainder.trimEnd().length
    result.push({
      text: remainder,
      relativeStart: cursor + leading,
      relativeEnd: text.length - trailing,
    })
  }
  return result
}
