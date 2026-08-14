import path from "node:path"
import JSZip from "jszip"
import { fail } from "./errors.js"
import { sha256 } from "./utils.js"
import { xlsxToMarkdown } from "./xlsx.js"

const MAX_ARCHIVE_ENTRIES = 5_000
const MAX_EXPANDED_BYTES = 200 * 1024 * 1024
const MAX_XML_BYTES = 50 * 1024 * 1024
const MAX_SLIDES = 1_000
const MAX_OCR_IMAGES = 200
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const OCR_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"])

export async function pptxToMarkdown(buffer, options = {}) {
  const zip = await loadPresentationArchive(buffer)
  const slidePaths = await presentationSlidePaths(zip)
  if (slidePaths.length === 0) fail("SOURCE_PARSE_FAILED", "The PowerPoint presentation contains no readable slides.")
  if (slidePaths.length > MAX_SLIDES) fail("SOURCE_PARSE_FAILED", `The PowerPoint presentation exceeds the ${MAX_SLIDES}-slide safety limit.`)

  const title = cleanHeading(options.fileName || "Presentation").replace(/\.(pptx|pptm)$/i, "") || "Presentation"
  const markdown = [`# ${title}`]
  const slides = []
  const ocrCache = new Map()
  let ocrImageCount = 0
  let nativeTextCharacters = 0
  let ocrTextCharacters = 0

  for (const [slideIndex, slidePath] of slidePaths.entries()) {
    options.signal?.throwIfAborted()
    const number = slideIndex + 1
    const xml = await readPart(zip, slidePath, { required: true })
    const parsed = parseSlide(xml)
    const slideMarkdown = [`## Slide ${number}`]
    if (parsed.paragraphs.length > 0) {
      slideMarkdown.push(`### ${parsed.paragraphs[0]}`)
      if (parsed.paragraphs.length > 1) slideMarkdown.push(parsed.paragraphs.slice(1).join("\n\n"))
      nativeTextCharacters += parsed.paragraphs.join("").length
    }
    for (const table of parsed.tables) {
      slideMarkdown.push(table)
      nativeTextCharacters += table.replace(/[^\p{L}\p{N}]/gu, "").length
    }
    const supplemental = await slideSupplementalContent(zip, slidePath)
    if (supplemental.markdown.length > 0) {
      slideMarkdown.push(...supplemental.markdown)
      nativeTextCharacters += supplemental.textCharacters
    }

    const imagePaths = await slideImagePaths(zip, slidePath)
    const ocrImages = []
    for (const [imageIndex, imagePath] of imagePaths.entries()) {
      ocrImageCount += 1
      if (ocrImageCount > (options.maxOcrImages ?? MAX_OCR_IMAGES)) {
        fail("SOURCE_PARSE_FAILED", `The PowerPoint presentation exceeds the ${options.maxOcrImages ?? MAX_OCR_IMAGES}-image OCR safety limit.`)
      }
      const image = await readBinaryPart(zip, imagePath)
      if (image.length > MAX_IMAGE_BYTES) fail("SOURCE_PARSE_FAILED", `PowerPoint image ${path.posix.basename(imagePath)} exceeds the OCR safety limit.`)
      const hash = sha256(image)
      let recognized = ocrCache.get(hash)
      if (!recognized) {
        recognized = await options.ocrSession.recognize(image, {
          kind: "powerpoint-image",
          slideNumber: number,
          imageName: path.posix.basename(imagePath),
          signal: options.signal,
        })
        ocrCache.set(hash, recognized)
      }
      if (!recognized.text) continue
      ocrTextCharacters += recognized.text.length
      const imageRecord = {
        imageName: path.posix.basename(imagePath),
        textCharacters: recognized.text.length,
        ...(recognized.confidence !== undefined ? { confidence: recognized.confidence } : {}),
      }
      ocrImages.push(imageRecord)
      slideMarkdown.push(`#### OCR image ${imageIndex + 1}\n\n${recognized.text}`)
    }

    if (parsed.paragraphs.length === 0 && parsed.tables.length === 0 && ocrImages.length === 0) {
      slideMarkdown.push("_No readable text detected._")
    }
    markdown.push(slideMarkdown.join("\n\n"))
    slides.push({
      slideNumber: number,
      nativeParagraphCount: parsed.paragraphs.length,
      tableCount: parsed.tables.length,
      imageCount: imagePaths.length,
      ocrImages,
      partName: slidePath,
      supplementalObjectCount: supplemental.objectCount,
      reviewWarnings: supplemental.reviewWarnings,
    })
  }

  if (nativeTextCharacters + ocrTextCharacters === 0) {
    fail("SOURCE_PARSE_FAILED", "The PowerPoint presentation contains no usable native or OCR text.")
  }
  return {
    markdown: markdown.join("\n\n"),
    metadata: {
      presentationType: "powerpoint-openxml",
      slideCount: slidePaths.length,
      nativeTextCharacters,
      ocrTextCharacters,
      ocrImageCount,
      ocrLanguages: options.ocrSession.languages,
      macrosExecuted: false,
      externalLinksFollowed: false,
      slides,
    },
  }
}

async function presentationSlidePaths(zip) {
  const presentation = await readPart(zip, "ppt/presentation.xml")
  const relationships = await readPart(zip, "ppt/_rels/presentation.xml.rels")
  if (presentation && relationships) {
    const targets = relationshipTargets(relationships)
    const ordered = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*\/?\s*>/gi)]
      .map((match) => targets.get(match[1] ?? match[2]))
      .filter(Boolean)
      .map((target) => path.posix.normalize(path.posix.join("ppt", target)))
      .filter((target) => /^ppt\/slides\/[^/]+\.xml$/i.test(target) && zip.file(target))
    if (ordered.length > 0) return [...new Set(ordered)]
  }
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
}

function relationshipTargets(xml) {
  const targets = new Map()
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = parseAttributes(match[1])
    if (attributes.Id && attributes.Target && attributes.TargetMode !== "External") targets.set(attributes.Id, attributes.Target)
  }
  return targets
}

async function slideSupplementalContent(zip, slidePath) {
  const relationshipPath = path.posix.join(path.posix.dirname(slidePath), "_rels", `${path.posix.basename(slidePath)}.rels`)
  const relationships = await readPart(zip, relationshipPath)
  const markdown = []
  const reviewWarnings = []
  let textCharacters = 0
  let objectCount = 0
  for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = parseAttributes(match[1])
    if (!attributes.Target || attributes.TargetMode === "External" || attributes.Type?.endsWith("/image")) continue
    const resolved = attributes.Target.startsWith("/")
      ? path.posix.normalize(attributes.Target.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(slidePath), attributes.Target))
    if (!resolved.startsWith("ppt/") || resolved.split("/").includes("..")) fail("SOURCE_PARSE_FAILED", "The PowerPoint presentation contains an unsafe object relationship.")
    if (attributes.Type?.endsWith("/chart") || attributes.Type?.endsWith("/diagramData")) {
      const xml = await readPart(zip, resolved)
      const values = [...xml.matchAll(/<(?:a:t|c:v|c:f)\b[^>]*>([\s\S]*?)<\/(?:a:t|c:v|c:f)>/gi)]
        .map((entry) => decodeXml(entry[1]).replace(/\s+/g, " ").trim()).filter(Boolean)
      if (values.length > 0) {
        const kind = attributes.Type.endsWith("/chart") ? "Chart data" : "SmartArt data"
        const rendered = `#### ${kind}\n\n${values.map((value) => `- ${value}`).join("\n")}`
        markdown.push(rendered)
        textCharacters += values.join("").length
        objectCount += 1
      }
      if (attributes.Type?.endsWith("/chart")) {
        const chartRelationshipsPath = path.posix.join(path.posix.dirname(resolved), "_rels", `${path.posix.basename(resolved)}.rels`)
        const chartRelationships = await readPart(zip, chartRelationshipsPath)
        for (const related of relationshipTargets(chartRelationships).values()) {
          const workbookPath = path.posix.normalize(path.posix.join(path.posix.dirname(resolved), related))
          if (!workbookPath.startsWith("ppt/") || !/\.xlsx$/i.test(workbookPath)) continue
          const workbook = await readBinaryPart(zip, workbookPath, 50 * 1024 * 1024)
          const parsed = await xlsxToMarkdown(workbook, { fileName: path.posix.basename(workbookPath), maxTableChars: 7_500 })
          markdown.push(`#### Embedded chart workbook\n\n${parsed.markdown}`)
          textCharacters += parsed.markdown.length
          objectCount += 1
        }
      }
      continue
    }
    if (attributes.Type?.endsWith("/package") && /\.xlsx$/i.test(resolved)) {
      const workbook = await readBinaryPart(zip, resolved, 50 * 1024 * 1024)
      const parsed = await xlsxToMarkdown(workbook, { fileName: path.posix.basename(resolved), maxTableChars: 7_500 })
      markdown.push(`#### Embedded workbook\n\n${parsed.markdown}`)
      textCharacters += parsed.markdown.length
      objectCount += 1
      continue
    }
    if (/\/(oleObject|package|diagramData|chart)$/i.test(attributes.Type ?? "")) {
      reviewWarnings.push(`Unsupported embedded object: ${path.posix.basename(resolved)}`)
      markdown.push(`#### Review required\n\nUnsupported embedded object ${path.posix.basename(resolved)} was not silently ignored.`)
    }
  }
  return { markdown, textCharacters, objectCount, reviewWarnings }
}

async function loadPresentationArchive(buffer) {
  let zip
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true })
  } catch {
    fail("SOURCE_PARSE_FAILED", "The PowerPoint archive is invalid or corrupt.")
  }
  const entries = Object.values(zip.files)
  if (entries.length > MAX_ARCHIVE_ENTRIES) fail("SOURCE_PARSE_FAILED", "The PowerPoint archive contains too many entries.")
  const declaredBytes = entries.reduce((sum, entry) => sum + Number(entry?._data?.uncompressedSize ?? 0), 0)
  if (declaredBytes > MAX_EXPANDED_BYTES) fail("SOURCE_PARSE_FAILED", "The PowerPoint archive expands beyond the safe parsing limit.")
  return zip
}

async function readPart(zip, name, options = {}) {
  const file = zip.file(name)
  if (!file) {
    if (options.required) fail("SOURCE_PARSE_FAILED", `The PowerPoint presentation is missing ${name}.`)
    return ""
  }
  if (Number(file?._data?.uncompressedSize ?? 0) > MAX_XML_BYTES) fail("SOURCE_PARSE_FAILED", `PowerPoint part ${name} exceeds the safe parsing limit.`)
  const xml = await file.async("string")
  if (Buffer.byteLength(xml) > MAX_XML_BYTES) fail("SOURCE_PARSE_FAILED", `PowerPoint part ${name} exceeds the safe parsing limit.`)
  return xml
}

async function readBinaryPart(zip, name, maximumBytes = MAX_IMAGE_BYTES) {
  const file = zip.file(name)
  if (!file) fail("SOURCE_PARSE_FAILED", `The PowerPoint presentation is missing image ${name}.`)
  if (Number(file?._data?.uncompressedSize ?? 0) > maximumBytes) fail("SOURCE_PARSE_FAILED", `PowerPoint part ${name} exceeds the safety limit.`)
  return file.async("nodebuffer")
}

function parseSlide(xml) {
  const tables = []
  const remaining = xml.replace(/<a:tbl\b[\s\S]*?<\/a:tbl>/gi, (tableXml) => {
    const rendered = parseTable(tableXml)
    if (rendered) tables.push(rendered)
    return ""
  })
  const paragraphs = [...remaining.matchAll(/<a:p\b[\s\S]*?<\/a:p>/gi)]
    .map((match) => presentationText(match[0]))
    .filter(Boolean)
  return { paragraphs, tables }
}

function parseTable(xml) {
  const rows = [...xml.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/gi)].map((row) =>
    [...row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/gi)].map((cell) => presentationText(cell[0]).replace(/\|/g, "\\|") || " "),
  ).filter((row) => row.length > 0)
  if (rows.length === 0) return ""
  const width = Math.max(...rows.map((row) => row.length))
  const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill(" ")])
  return [normalized[0], Array(width).fill("---"), ...normalized.slice(1)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n")
}

function presentationText(xml) {
  return [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:(br|tab)\b[^>]*\/?\s*>/gi)]
    .map((match) => match[2] === "br" ? "\n" : match[2] === "tab" ? "\t" : decodeXml(match[1]))
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim()
}

async function slideImagePaths(zip, slidePath) {
  const relationshipPath = path.posix.join(path.posix.dirname(slidePath), "_rels", `${path.posix.basename(slidePath)}.rels`)
  const xml = await readPart(zip, relationshipPath)
  if (!xml) return []
  const targets = []
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = parseAttributes(match[1])
    if (attributes.TargetMode === "External" || !attributes.Type?.endsWith("/image") || !attributes.Target) continue
    const resolved = attributes.Target.startsWith("/")
      ? path.posix.normalize(attributes.Target.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(slidePath), attributes.Target))
    if (!resolved.startsWith("ppt/media/") || resolved.split("/").includes("..")) {
      fail("SOURCE_PARSE_FAILED", "The PowerPoint presentation contains an unsafe image relationship.")
    }
    if (!OCR_IMAGE_EXTENSIONS.has(path.posix.extname(resolved).toLowerCase())) continue
    if (!targets.includes(resolved)) targets.push(resolved)
  }
  return targets
}

function parseAttributes(value) {
  return Object.fromEntries([...value.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map((match) => [match[1], decodeXml(match[2] ?? match[3] ?? "")]))
}

function slideNumber(name) {
  return Number(name.match(/slide(\d+)\.xml$/i)?.[1] ?? 0)
}

function cleanHeading(value) {
  return decodeXml(String(value)).replace(/[\r\n#|]+/g, " ").replace(/\s+/g, " ").trim()
}

function decodeXml(value = "") {
  return value.replace(/&#(x?[0-9a-f]+);|&([a-z]+);/gi, (_all, numeric, named) => {
    if (numeric) return String.fromCodePoint(Number.parseInt(numeric.replace(/^x/i, ""), numeric.startsWith("x") ? 16 : 10))
    return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " })[named.toLowerCase()] ?? _all
  })
}
