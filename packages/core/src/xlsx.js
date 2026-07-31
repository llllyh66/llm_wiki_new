import path from "node:path"
import JSZip from "jszip"
import { fail } from "./errors.js"

const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_EXPANDED_BYTES = 150 * 1024 * 1024
const MAX_XML_BYTES = 50 * 1024 * 1024
const MAX_SHEETS = 200
const MAX_CELLS = 250_000
const MAX_CELL_CHARS = 20_000
const MAX_COLUMNS_PER_TABLE = 32
const MAX_WORKSHEET_ROWS = 1_048_576
const MAX_WORKSHEET_COLUMNS = 16_384

export async function xlsxToMarkdown(buffer, options = {}) {
  const zip = await loadWorkbookArchive(buffer)
  const workbookXml = await readXml(zip, "xl/workbook.xml", { required: true })
  const relationshipsXml = await readXml(zip, "xl/_rels/workbook.xml.rels", { required: true })
  const relationships = parseRelationships(relationshipsXml)
  const sharedStrings = await parseSharedStrings(zip)
  const styles = await parseStyles(zip)
  const date1904 = /<workbookPr\b[^>]*\bdate1904=(?:"1"|'1'|"true"|'true')/i.test(workbookXml)
  const sheetRecords = parseWorkbookSheets(workbookXml, relationships)
  if (sheetRecords.length === 0) fail("SOURCE_PARSE_FAILED", "The XLSX workbook contains no readable worksheets.")
  if (sheetRecords.length > MAX_SHEETS) fail("SOURCE_PARSE_FAILED", `The XLSX workbook exceeds the ${MAX_SHEETS}-worksheet safety limit.`)

  const workbookTitle = cleanHeading(options.fileName || "Workbook").replace(/\.xlsx$/i, "") || "Workbook"
  const markdown = [`# ${workbookTitle}`]
  const tables = []
  const sheets = []
  let totalCells = 0

  for (const sheetRecord of sheetRecords) {
    const xml = await readXml(zip, sheetRecord.path, { required: true })
    const parsed = parseWorksheet(xml, { sharedStrings, styles, date1904 })
    totalCells += parsed.cellCount
    if (totalCells > MAX_CELLS) fail("SOURCE_PARSE_FAILED", `The XLSX workbook exceeds the ${MAX_CELLS}-cell safety limit.`)
    const sheetName = cleanHeading(sheetRecord.name) || "Sheet"
    markdown.push(`## Sheet: ${sheetName}`)
    const segments = buildTableSegments(parsed, {
      sheetName,
      sheetState: sheetRecord.state,
      maxTableChars: Math.max(1_000, Number(options.maxTableChars) || 7_000),
    })
    if (segments.length === 0) markdown.push("_No non-empty cells._")
    for (const segment of segments) {
      markdown.push(`### Range ${segment.cellRange}`)
      markdown.push(segment.markdown)
      tables.push(segment)
    }
    sheets.push({
      name: sheetName,
      state: sheetRecord.state,
      cellCount: parsed.cellCount,
      tableCount: segments.length,
      usedRange: parsed.usedRange,
    })
  }

  if (totalCells === 0) fail("SOURCE_PARSE_FAILED", "The XLSX workbook contains no usable cell values.")
  return {
    markdown: markdown.join("\n\n"),
    tables,
    metadata: {
      workbookType: "xlsx",
      calculationPolicy: "cached-values-only",
      formulasExecuted: false,
      externalLinksFollowed: false,
      sheets,
    },
  }
}

async function loadWorkbookArchive(buffer) {
  let zip
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true })
  } catch {
    fail("SOURCE_PARSE_FAILED", "The XLSX archive is invalid or corrupt.")
  }
  const entries = Object.values(zip.files)
  if (entries.length > MAX_ARCHIVE_ENTRIES) fail("SOURCE_PARSE_FAILED", "The XLSX archive contains too many entries.")
  const declaredBytes = entries.reduce((sum, entry) => sum + Number(entry?._data?.uncompressedSize ?? 0), 0)
  if (declaredBytes > MAX_EXPANDED_BYTES) fail("SOURCE_PARSE_FAILED", "The XLSX archive expands beyond the safe parsing limit.")
  return zip
}

async function readXml(zip, name, options = {}) {
  const file = zip.file(name)
  if (!file) {
    if (options.required) fail("SOURCE_PARSE_FAILED", `The XLSX workbook is missing ${name}.`)
    return ""
  }
  if (Number(file?._data?.uncompressedSize ?? 0) > MAX_XML_BYTES) fail("SOURCE_PARSE_FAILED", `The XLSX part ${name} exceeds the safe parsing limit.`)
  const xml = await file.async("string")
  if (Buffer.byteLength(xml) > MAX_XML_BYTES) fail("SOURCE_PARSE_FAILED", `The XLSX part ${name} exceeds the safe parsing limit.`)
  return xml
}

function parseRelationships(xml) {
  const relationships = new Map()
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = parseAttributes(match[1])
    if (!attributes.Id || !attributes.Target || attributes.TargetMode === "External") continue
    relationships.set(attributes.Id, attributes.Target)
  }
  return relationships
}

function parseWorkbookSheets(xml, relationships) {
  const sheets = []
  for (const match of xml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const attributes = parseAttributes(match[1])
    const relationshipId = attributes["r:id"]
    const target = relationships.get(relationshipId)
    if (!target) continue
    const resolved = target.startsWith("/")
      ? path.posix.normalize(target.slice(1))
      : path.posix.normalize(path.posix.join("xl", target))
    if (!resolved.startsWith("xl/worksheets/") || resolved.split("/").includes("..")) {
      fail("SOURCE_PARSE_FAILED", "The XLSX workbook contains an unsafe worksheet relationship.")
    }
    sheets.push({
      name: attributes.name || `Sheet ${sheets.length + 1}`,
      state: attributes.state || "visible",
      path: resolved,
    })
  }
  return sheets
}

async function parseSharedStrings(zip) {
  const xml = await readXml(zip, "xl/sharedStrings.xml")
  if (!xml) return []
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => xmlText(match[1]))
}

async function parseStyles(zip) {
  const xml = await readXml(zip, "xl/styles.xml")
  if (!xml) return { styleNumberFormats: [], customNumberFormats: new Map() }
  const customNumberFormats = new Map()
  const numFmts = xml.match(/<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/i)?.[1] ?? ""
  for (const match of numFmts.matchAll(/<numFmt\b([^>]*)\/?\s*>/gi)) {
    const attributes = parseAttributes(match[1])
    if (Number.isInteger(Number(attributes.numFmtId))) customNumberFormats.set(Number(attributes.numFmtId), attributes.formatCode || "")
  }
  const cellXfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/i)?.[1] ?? ""
  const styleNumberFormats = [...cellXfs.matchAll(/<xf\b([^>]*)\/?\s*>/gi)]
    .map((match) => Number(parseAttributes(match[1]).numFmtId || 0))
  return { styleNumberFormats, customNumberFormats }
}

function parseWorksheet(xml, context) {
  const cells = new Map()
  const formulas = []
  const hiddenRows = new Set()
  const hiddenColumns = new Set()
  const mergedCells = parseMergedCells(xml)
  let inferredRow = 0
  let cellCount = 0

  for (const columnMatch of xml.matchAll(/<col\b([^>]*)\/?\s*>/gi)) {
    const attributes = parseAttributes(columnMatch[1])
    if (attributes.hidden !== "1" && attributes.hidden !== "true") continue
    const first = Math.max(1, Number(attributes.min || 1))
    const last = Math.min(MAX_WORKSHEET_COLUMNS, Number(attributes.max || first))
    for (let column = first; column <= last; column += 1) hiddenColumns.add(column)
  }

  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    const rowAttributes = parseAttributes(rowMatch[1])
    const rowNumber = positiveInteger(rowAttributes.r) || inferredRow + 1
    if (rowNumber > MAX_WORKSHEET_ROWS) fail("SOURCE_PARSE_FAILED", "The XLSX worksheet contains an out-of-range row reference.")
    inferredRow = rowNumber
    if (rowAttributes.hidden === "1" || rowAttributes.hidden === "true") hiddenRows.add(rowNumber)
    let inferredColumn = 0
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attributes = parseAttributes(cellMatch[1])
      const reference = parseCellReference(attributes.r)
      const column = reference?.column || inferredColumn + 1
      const actualRow = reference?.row || rowNumber
      if (column > MAX_WORKSHEET_COLUMNS || actualRow > MAX_WORKSHEET_ROWS) fail("SOURCE_PARSE_FAILED", "The XLSX worksheet contains an out-of-range cell reference.")
      inferredColumn = column
      const decoded = decodeCell(cellMatch[2], attributes, context)
      if (!decoded.hasValue && !decoded.formula) continue
      if (decoded.value.length > MAX_CELL_CHARS) fail("SOURCE_PARSE_FAILED", `Cell ${columnName(column)}${actualRow} exceeds the safe text limit.`)
      if (!cells.has(actualRow)) cells.set(actualRow, new Map())
      cells.get(actualRow).set(column, decoded.value)
      cellCount += 1
      if (cellCount > MAX_CELLS) fail("SOURCE_PARSE_FAILED", `A worksheet exceeds the ${MAX_CELLS}-cell safety limit.`)
      if (decoded.formula) formulas.push({
        cell: `${columnName(column)}${actualRow}`,
        formula: decoded.formula,
        cachedValue: decoded.cachedValue,
        ...(decoded.formulaType ? { formulaType: decoded.formulaType } : {}),
        ...(decoded.sharedIndex !== undefined ? { sharedIndex: decoded.sharedIndex } : {}),
      })
    }
  }

  const rows = [...cells.keys()].sort((a, b) => a - b)
  const columns = [...new Set([...cells.values()].flatMap((row) => [...row.keys()]))].sort((a, b) => a - b)
  return {
    cells,
    rows,
    columns,
    formulas,
    hiddenRows: [...hiddenRows].sort((a, b) => a - b),
    hiddenColumns: [...hiddenColumns].sort((a, b) => a - b),
    mergedCells,
    cellCount,
    usedRange: rows.length > 0 && columns.length > 0
      ? `${columnName(columns[0])}${rows[0]}:${columnName(columns.at(-1))}${rows.at(-1)}`
      : undefined,
  }
}

function decodeCell(body, attributes, context) {
  const formulaMatch = body.match(/<f\b([^>]*)>([\s\S]*?)<\/f>|<f\b([^>]*)\/?\s*>/i)
  const formulaAttributes = parseAttributes(formulaMatch?.[1] || formulaMatch?.[3] || "")
  const formula = formulaMatch ? decodeXml(formulaMatch[2] || "").trim() || `[shared formula ${formulaAttributes.si || ""}]`.trim() : undefined
  const raw = decodeXml(body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? "")
  const type = attributes.t || "n"
  let value = raw
  if (type === "s") value = context.sharedStrings[Number(raw)] ?? ""
  else if (type === "inlineStr") value = xmlText(body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/i)?.[1] ?? "")
  else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE"
  else if (type === "d") value = normalizeIsoDate(raw)
  else if (type === "n" && raw && isDateStyle(attributes.s, context.styles)) value = excelDate(raw, context.date1904)
  if (!value && formula) value = `=${formula}`
  return {
    value: String(value).replace(/\r\n?/g, "\n"),
    cachedValue: raw,
    hasValue: raw !== "" || type === "inlineStr",
    formula,
    formulaType: formulaAttributes.t,
    sharedIndex: formulaAttributes.si === undefined ? undefined : Number(formulaAttributes.si),
  }
}

function isDateStyle(styleIndex, styles) {
  const numberFormatId = styles.styleNumberFormats[Number(styleIndex || 0)]
  if ((numberFormatId >= 14 && numberFormatId <= 22)
    || (numberFormatId >= 27 && numberFormatId <= 36)
    || (numberFormatId >= 45 && numberFormatId <= 47)
    || (numberFormatId >= 50 && numberFormatId <= 58)) return true
  const custom = styles.customNumberFormats.get(numberFormatId)
  if (!custom) return false
  const cleaned = custom
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*]/g, "")
    .replace(/\\./g, "")
    .replace(/_.|\*./g, "")
  return /[ydhs]/i.test(cleaned) || /m{2,}/i.test(cleaned)
}

function excelDate(raw, date1904) {
  const serial = Number(raw)
  if (!Number.isFinite(serial)) return raw
  if (!date1904 && serial === 60) return "1900-02-29"
  const adjusted = date1904 ? serial : serial - (serial >= 60 ? 1 : 0)
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31)
  const date = new Date(epoch + adjusted * 86_400_000)
  if (Number.isNaN(date.valueOf())) return raw
  const iso = date.toISOString()
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.replace(/\.000Z$/, "Z")
}

function normalizeIsoDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toISOString().replace(/\.000Z$/, "Z")
}

function parseMergedCells(xml) {
  const merged = []
  for (const match of xml.matchAll(/<mergeCell\b([^>]*)\/?\s*>/gi)) {
    const reference = parseRange(parseAttributes(match[1]).ref)
    if (!reference) continue
    merged.push({
      range: reference.range,
      startRow: reference.start.row,
      endRow: reference.end.row,
      startColumn: columnName(reference.start.column),
      endColumn: columnName(reference.end.column),
      rowSpan: reference.end.row - reference.start.row + 1,
      columnSpan: reference.end.column - reference.start.column + 1,
    })
  }
  return merged
}

function buildTableSegments(parsed, options) {
  if (parsed.rows.length === 0 || parsed.columns.length === 0) return []
  const tables = []
  for (let columnStart = 0; columnStart < parsed.columns.length; columnStart += MAX_COLUMNS_PER_TABLE) {
    const columns = parsed.columns.slice(columnStart, columnStart + MAX_COLUMNS_PER_TABLE)
    let segmentRows = []
    const tableHeaderLength = renderTableHeader(columns).length
    let segmentLength = tableHeaderLength
    const emit = () => {
      if (segmentRows.length === 0) return
      const firstRow = segmentRows[0]
      const lastRow = segmentRows.at(-1)
      const firstColumn = columns[0]
      const lastColumn = columns.at(-1)
      const markdown = renderTable(parsed.cells, segmentRows, columns)
      tables.push({
        markdown,
        sheetName: options.sheetName,
        sheetState: options.sheetState,
        cellRange: `${columnName(firstColumn)}${firstRow}:${columnName(lastColumn)}${lastRow}`,
        columns: columns.map(columnName),
        rowNumbers: segmentRows,
        mergedCells: parsed.mergedCells.filter((merge) => rangesOverlap(merge, firstRow, lastRow, firstColumn, lastColumn)),
        formulas: parsed.formulas.filter((formula) => {
          const cell = parseCellReference(formula.cell)
          return cell && cell.row >= firstRow && cell.row <= lastRow && cell.column >= firstColumn && cell.column <= lastColumn
        }),
        hiddenRows: parsed.hiddenRows.filter((row) => row >= firstRow && row <= lastRow),
        hiddenColumns: parsed.hiddenColumns.filter((column) => columns.includes(column)).map(columnName),
      })
      segmentRows = []
      segmentLength = tableHeaderLength
    }
    for (const row of parsed.rows) {
      if (!columns.some((column) => parsed.cells.get(row)?.has(column))) continue
      const lineLength = renderTableRow(parsed.cells, row, columns).length + 1
      if (segmentRows.length > 0 && segmentLength + lineLength > options.maxTableChars) emit()
      segmentRows.push(row)
      segmentLength += lineLength
    }
    emit()
  }
  return tables
}

function renderTable(cells, rows, columns) {
  return `${renderTableHeader(columns)}\n${rows.map((row) => renderTableRow(cells, row, columns)).join("\n")}`
}

function renderTableHeader(columns) {
  const header = ["Row", ...columns.map(columnName)]
  const delimiter = header.map(() => "---")
  return [header, delimiter].map((row) => `| ${row.join(" | ")} |`).join("\n")
}

function renderTableRow(cells, row, columns) {
  const values = [String(row), ...columns.map((column) => markdownCell(cells.get(row)?.get(column) ?? ""))]
  return `| ${values.join(" | ")} |`
}

function rangesOverlap(merge, firstRow, lastRow, firstColumn, lastColumn) {
  const startColumn = columnNumber(merge.startColumn)
  const endColumn = columnNumber(merge.endColumn)
  return merge.endRow >= firstRow && merge.startRow <= lastRow && endColumn >= firstColumn && startColumn <= lastColumn
}

function parseRange(value) {
  const [startValue, endValue = startValue] = String(value || "").split(":")
  const start = parseCellReference(startValue)
  const end = parseCellReference(endValue)
  if (!start || !end) return undefined
  return { start, end, range: `${columnName(start.column)}${start.row}:${columnName(end.column)}${end.row}` }
}

function parseCellReference(value) {
  const match = String(value || "").replace(/\$/g, "").match(/^([A-Z]{1,3})([1-9]\d*)$/i)
  if (!match) return undefined
  const column = columnNumber(match[1])
  const row = Number(match[2])
  if (column < 1 || column > MAX_WORKSHEET_COLUMNS || row > MAX_WORKSHEET_ROWS) return undefined
  return { column, row }
}

function columnNumber(value) {
  let number = 0
  for (const character of String(value).toUpperCase()) number = number * 26 + character.charCodeAt(0) - 64
  return number
}

function columnName(number) {
  let value = Number(number)
  let name = ""
  while (value > 0) {
    value -= 1
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26)
  }
  return name
}

function parseAttributes(value) {
  const attributes = {}
  for (const match of String(value).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? "")
  }
  return attributes
}

function xmlText(xml) {
  return [...String(xml).matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((match) => decodeXml(match[1])).join("")
}

function decodeXml(value = "") {
  return String(value).replace(/&#(x?[0-9a-f]+);|&([a-z]+);/gi, (_all, numeric, named) => {
    if (numeric) return String.fromCodePoint(Number.parseInt(numeric.replace(/^x/i, ""), numeric.startsWith("x") ? 16 : 10))
    return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " })[named.toLowerCase()] ?? _all
  })
}

function markdownCell(value) {
  return String(value).replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|").trim()
}

function cleanHeading(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim()
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}
