import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { LlmWikiError } from "./errors.js"
import { sha256, stableStringify } from "./utils.js"
import { xlsxToMarkdown } from "./xlsx.js"

export const EXCEL_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
export const ENHANCED_PARSER_VERSION = "excel-parser-0.2.1"
export const SPREADSHEET_DOCUMENT_VERSION = 2

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_CELLS_PER_SHEET = 250_000
const DEFAULT_MAX_TOTAL_CELLS = 750_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_BRIDGE_STDOUT_BYTES = 64 * 1024
const MAX_BRIDGE_STDERR_BYTES = 256 * 1024
const MAX_EXTERNAL_STRING_CHARS = 4_000
const MAX_EXTERNAL_ARRAY_ITEMS = 256
const MAX_EXTERNAL_CHUNKS = 20_000
const providerProbeCache = new Map()

/**
 * Parse an XLSX through the configured provider. The native parser remains the
 * safe baseline. The optional Python provider is isolated behind a short-lived
 * bridge process so Python stdout can never corrupt the MCP STDIO protocol.
 */
export async function parseSpreadsheet(filePath, options = {}) {
  const config = normalizeSpreadsheetConfig(options)
  const requested = config.provider
  let selected = requested === "native" ? "native" : await resolveSpreadsheetProvider(config)
  let fallback
  if (selected === "enhanced") {
    try {
      const enhanced = await parseWithEnhancedProvider(filePath, config)
      return { ...enhanced, requestedProvider: requested, fallbackUsed: false }
    } catch (error) {
      if (requested === "excel-parser") throw normalizeParserError(error)
      fallback = compactDiagnostic(error)
      selected = "native"
    }
  }
  const native = await parseWithNativeProvider(filePath, config)
  return {
    ...native,
    requestedProvider: requested,
    fallbackUsed: Boolean(fallback),
    diagnostics: fallback ? [fallback, ...(native.diagnostics ?? [])] : native.diagnostics ?? [],
  }
}

export function normalizeSpreadsheetConfig(options = {}) {
  const value = options?.excel && typeof options.excel === "object" ? options.excel : options
  const requestedProvider = String(value?.provider ?? "auto").trim().toLowerCase()
  const provider = new Set(["auto", "native", "excel-parser"]).has(requestedProvider) ? requestedProvider : "auto"
  const pythonExecutable = String(value?.pythonExecutable ?? value?.python_executable ?? process.env.LLM_WIKI_EXCEL_PYTHON ?? "python3").trim() || "python3"
  const timeoutMs = clampInteger(value?.timeoutMs ?? value?.timeout_ms, 10_000, 600_000, DEFAULT_TIMEOUT_MS)
  const maxCellsPerSheet = clampInteger(value?.maxCellsPerSheet ?? value?.max_cells_per_sheet, 10_000, 2_000_000, DEFAULT_MAX_CELLS_PER_SHEET)
  const maxTotalCells = clampInteger(value?.maxTotalCells ?? value?.max_total_cells, maxCellsPerSheet, 5_000_000, Math.max(DEFAULT_MAX_TOTAL_CELLS, maxCellsPerSheet))
  const maxOutputBytes = clampInteger(value?.maxOutputBytes ?? value?.max_output_bytes, 1 * 1024 * 1024, 256 * 1024 * 1024, DEFAULT_MAX_OUTPUT_BYTES)
  const maxChunkTokens = clampInteger(value?.maxChunkTokens ?? value?.max_chunk_tokens, 128, 2_048, 700)
  const maxChunkChars = clampInteger(value?.maxChunkChars ?? value?.max_chunk_chars, 1_000, 20_000, 6_000)
  return {
    provider,
    pythonExecutable,
    timeoutMs,
    maxCellsPerSheet,
    maxTotalCells,
    maxOutputBytes,
    maxChunkTokens,
    maxChunkChars,
    features: {
      formulas: value?.features?.formulas !== false,
      dependencies: value?.features?.dependencies !== false,
      namedRanges: value?.features?.namedRanges !== false,
      charts: value?.features?.charts !== false,
      kpiCandidates: value?.features?.kpiCandidates !== false,
      sheetSummaries: value?.features?.sheetSummaries !== false,
    },
  }
}

export async function resolveSpreadsheetProvider(options = {}) {
  const config = normalizeSpreadsheetConfig(options)
  if (config.provider === "native") return "native"
  const cacheKey = `${config.pythonExecutable}:${ENHANCED_PARSER_VERSION}`
  if (!providerProbeCache.has(cacheKey)) {
    providerProbeCache.set(cacheKey, probeEnhancedProvider(config).then((available) => available ? "enhanced" : "native").catch(() => "native"))
  }
  const selected = await providerProbeCache.get(cacheKey)
  if (config.provider === "excel-parser" && selected !== "enhanced") {
    throw new LlmWikiError("EXCEL_PARSER_UNAVAILABLE", "The enhanced Excel parser is not installed or cannot be started.", {
      retryable: true,
      details: { python_executable: config.pythonExecutable, package: ENHANCED_PARSER_VERSION },
    })
  }
  return selected
}

export function spreadsheetParserVersion(parsed) {
  const provider = parsed?.parser?.provider ?? parsed?.provider ?? "native"
  const version = parsed?.parser?.version ?? (provider === "excel-parser" ? ENHANCED_PARSER_VERSION : "native-ooxml-v2")
  return `spreadsheet-document-v${SPREADSHEET_DOCUMENT_VERSION}:${provider}:${version}`
}

export function spreadsheetParserFingerprint(options = {}, selectedProvider = "native") {
  const config = normalizeSpreadsheetConfig(options)
  return sha256(stableStringify({
    documentVersion: SPREADSHEET_DOCUMENT_VERSION,
    provider: selectedProvider,
    parserVersion: selectedProvider === "enhanced" ? ENHANCED_PARSER_VERSION : "native-ooxml-v2",
    maxChunkTokens: config.maxChunkTokens,
    maxChunkChars: options?.maxChunkChars,
    features: config.features,
  })).slice(0, 32)
}

async function parseWithNativeProvider(filePath, config) {
  const buffer = await readFile(filePath)
  const parsed = await xlsxToMarkdown(buffer, {
    fileName: path.basename(filePath),
    maxTableChars: Math.max(1_000, (config.maxChunkChars ?? 8_000) - 500),
  })
  const metadata = {
    ...(parsed.metadata ?? {}),
    parser: { provider: "native", version: "native-ooxml-v2", documentVersion: SPREADSHEET_DOCUMENT_VERSION },
  }
  const tables = (parsed.tables ?? []).map((table) => ({ ...table, retrievalViews: spreadsheetRetrievalViewsFromTable(table) }))
  return { ...parsed, tables, metadata, provider: "native", parser: metadata.parser, diagnostics: [] }
}

async function parseWithEnhancedProvider(filePath, config) {
  const raw = await runEnhancedBridge(filePath, config)
  return normalizeExternalParseResult(raw, path.basename(filePath), config)
}

async function probeEnhancedProvider(config) {
  const result = await runProcess(config.pythonExecutable, ["-c", "import excel_parser; print('ok')"], {
    timeoutMs: Math.min(config.timeoutMs, 10_000),
    input: "",
    maxStdoutBytes: 1_024,
    maxStderrBytes: 8 * 1_024,
  }).catch(() => null)
  return result?.code === 0 && result.stdout.trim() === "ok"
}

async function runEnhancedBridge(filePath, config) {
  const staging = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-excel-"))
  const outputPath = path.join(staging, `result-${randomUUID()}.json`)
  const bridgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "bridges", "excel-parser-bridge.py")
  const request = JSON.stringify({
    input_path: filePath,
    output_path: outputPath,
    filename: path.basename(filePath),
    max_cells_per_sheet: config.maxCellsPerSheet,
    max_chunk_tokens: config.maxChunkTokens,
  })
  try {
    const result = await runProcess(config.pythonExecutable, [bridgePath], {
      timeoutMs: config.timeoutMs,
      input: request,
      maxStdoutBytes: MAX_BRIDGE_STDOUT_BYTES,
      maxStderrBytes: MAX_BRIDGE_STDERR_BYTES,
    })
    if (result.code !== 0) {
      throw new LlmWikiError("EXCEL_PARSER_FAILED", "The enhanced Excel parser process failed.", {
        retryable: true,
        details: { exit_code: result.code, stderr: result.stderr.slice(0, 1_000) },
      })
    }
    let envelope
    try {
      envelope = JSON.parse(result.stdout)
    } catch {
      throw new LlmWikiError("EXCEL_PARSER_INVALID_RESPONSE", "The enhanced Excel parser bridge returned invalid JSON.", { retryable: true })
    }
    if (envelope?.ok !== true || envelope.output_path !== outputPath) {
      throw new LlmWikiError("EXCEL_PARSER_INVALID_RESPONSE", "The enhanced Excel parser bridge returned an invalid output envelope.", { retryable: true })
    }
    const outputInfo = await stat(outputPath)
    if (outputInfo.size > config.maxOutputBytes) {
      throw new LlmWikiError("EXCEL_PARSER_OUTPUT_TOO_LARGE", "The enhanced Excel parser result exceeds the configured output limit.", { retryable: true })
    }
    return JSON.parse(await readFile(outputPath, "utf8"))
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

async function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref?.()
      finish(reject, new LlmWikiError("EXCEL_PARSER_TIMEOUT", "The enhanced Excel parser exceeded its time limit.", { retryable: true }))
    }, options.timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
      if (Buffer.byteLength(stdout) > options.maxStdoutBytes) {
        child.kill("SIGTERM")
        finish(reject, new LlmWikiError("EXCEL_PARSER_INVALID_RESPONSE", "The enhanced Excel parser bridge output is too large.", { retryable: true }))
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
      if (Buffer.byteLength(stderr) > options.maxStderrBytes) stderr = stderr.slice(-options.maxStderrBytes)
    })
    child.on("error", (error) => finish(reject, new LlmWikiError("EXCEL_PARSER_UNAVAILABLE", `Could not start the enhanced Excel parser: ${error.message}`, { retryable: true })))
    child.on("close", (code, signal) => finish(resolve, { code: code ?? 1, signal, stdout, stderr }))
    child.stdin.end(options.input ?? "")
  })
}

export function normalizeExternalParseResult(raw, filename, config = {}) {
  const workbook = raw?.workbook && typeof raw.workbook === "object" ? raw.workbook : {}
  const rawChunks = Array.isArray(raw?.chunks) ? raw.chunks : []
  const totalCells = Number(workbook.total_cells ?? workbook.totalCells) || 0
  if (Number.isFinite(Number(config.maxTotalCells)) && totalCells > Number(config.maxTotalCells)) {
    throw new LlmWikiError("EXCEL_PARSER_TOO_MANY_CELLS", "The enhanced Excel parser workbook exceeds the configured cell limit.", { retryable: true })
  }
  if (rawChunks.length > MAX_EXTERNAL_CHUNKS) {
    throw new LlmWikiError("EXCEL_PARSER_TOO_MANY_CHUNKS", "The enhanced Excel parser returned too many chunks.", { retryable: true })
  }
  if (rawChunks.length === 0) throw new LlmWikiError("EXCEL_PARSER_EMPTY_RESULT", "The enhanced Excel parser returned no readable chunks.", { retryable: true })
  const chunks = []
  const diagnostics = boundedDiagnostics(workbook.errors)
  for (const rawChunk of rawChunks) {
    const base = normalizeExternalChunk(rawChunk, config)
    if (!base) continue
    const parts = splitCanonicalChunk(base, Number(config.maxChunkChars) || 6_000)
    chunks.push(...parts)
  }
  if (chunks.length === 0) throw new LlmWikiError("EXCEL_PARSER_EMPTY_RESULT", "The enhanced Excel parser returned no usable text chunks.", { retryable: true })
  const markdownParts = [`# ${safeTitle(filename)}`]
  let offset = markdownParts[0].length
  for (const chunk of chunks) {
    const sheetHeading = `\n\n## Sheet: ${chunk.sheetName || "Workbook"}`
    markdownParts.push(sheetHeading)
    offset += sheetHeading.length
    const rangeHeading = `\n\n### Range ${chunk.cellRange || "unknown"}`
    markdownParts.push(rangeHeading)
    offset += rangeHeading.length
    chunk.startOffset = offset + 2
    markdownParts.push(`\n\n${chunk.text}`)
    offset += 2 + chunk.text.length
    chunk.endOffset = offset
  }
  const markdown = markdownParts.join("")
  const parser = { provider: "excel-parser", version: ENHANCED_PARSER_VERSION, documentVersion: SPREADSHEET_DOCUMENT_VERSION }
  return {
    markdown,
    tables: [],
    chunks,
    provider: "enhanced",
    parser,
    metadata: {
      parser,
      workbook: compactWorkbookMetadata(workbook),
      diagnostics,
      formulasExecuted: false,
      externalLinksFollowed: false,
    },
    diagnostics,
  }
}

function normalizeExternalChunk(raw, config) {
  if (!raw || typeof raw !== "object") return null
  const sheetName = boundedString(raw.sheet_name ?? raw.sheetName, 500)
  const sourceUri = boundedString(raw.source_uri ?? raw.sourceUri, 1_000)
  const parsedUri = parseSourceUri(sourceUri)
  const effectiveSheet = sheetName || parsedUri.sheetName
  const cellRange = boundedString(raw.cell_range ?? raw.cellRange, 200) || parsedUri.cellRange
    || [raw.top_left ?? raw.topLeft, raw.bottom_right ?? raw.bottomRight].filter(Boolean).join(":") || undefined
  const renderText = boundedString(raw.render_text ?? raw.renderText, 20_000)
  if (!renderText.trim()) return null
  const blockType = boundedString(raw.block_type ?? raw.blockType, 100) || "block"
  const cells = boundedArray(raw.cells, MAX_EXTERNAL_ARRAY_ITEMS).map((cell) => compactCell(cell)).filter(Boolean)
  const formulas = cells.filter((cell) => cell.formula).map((cell) => ({ address: cell.address, formula: cell.formula, value: cell.value }))
  const dependency = compactDependency(raw.dependency_summary ?? raw.dependencySummary)
  const keyCells = boundedArray(raw.key_cells ?? raw.keyCells, MAX_EXTERNAL_ARRAY_ITEMS).map((value) => compactCell(value) ?? boundedString(value, 200)).filter(Boolean)
  const namedRanges = boundedArray(raw.named_ranges ?? raw.namedRanges, MAX_EXTERNAL_ARRAY_ITEMS).map((value) => boundedString(value?.name ?? value, 200)).filter(Boolean)
  const metadata = compactObject(raw.metadata, 12)
  const contextLines = [
    effectiveSheet ? `Sheet: ${effectiveSheet}` : null,
    cellRange ? `Range: ${cellRange}` : null,
    `Block type: ${blockType}`,
    keyCells.length > 0 ? `Key cells: ${keyCells.map((cell) => typeof cell === "string" ? cell : `${cell.address}=${cell.value}`).join("; ")}` : null,
    namedRanges.length > 0 ? `Named ranges: ${namedRanges.join(", ")}` : null,
    `Content:\n${renderText}`,
    formulas.length > 0 ? `Formulas:\n${formulas.map((item) => `${item.address}: ${item.formula}${item.value ? ` => ${item.value}` : ""}`).join("\n")}` : null,
    dependencySummaryText(dependency),
  ].filter(Boolean)
  const text = contextLines.join("\n")
  const structured = {
    kind: "excel-block",
    markdown: text,
    text,
    sheetName: effectiveSheet,
    cellRange,
    blockType,
    ...(cells.length > 0 ? { cells } : {}),
    ...(formulas.length > 0 ? { formulas } : {}),
    ...(keyCells.length > 0 ? { keyCells } : {}),
    ...(namedRanges.length > 0 ? { namedRanges } : {}),
    ...(dependency ? { dependencySummary: dependency } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
  const contentHash = sha256(`${effectiveSheet ?? ""}:${cellRange ?? ""}:${text}`)
  return {
    chunkId: `chunk-${sha256(`excel-parser:${raw.chunk_id ?? raw.chunkId ?? contentHash}:${contentHash}`).slice(0, 24)}`,
    sourceId: undefined,
    ordinal: 0,
    headingPath: [effectiveSheet ? `Sheet: ${effectiveSheet}` : "Workbook"],
    blockKinds: ["table", blockType],
    text,
    structuredData: [structured],
    retrievalViews: spreadsheetRetrievalViewsFromTable(structured),
    sheetName: effectiveSheet,
    cellRange,
    // The external parser may echo an absolute input path in source_uri. Keep
    // only the stable workbook-local locator so private filesystem paths never
    // enter managed task state or MCP responses.
    sourceUri: effectiveSheet && cellRange ? `${effectiveSheet}!${cellRange}` : undefined,
    tokenEstimate: Number.isFinite(Number(raw.token_count ?? raw.tokenCount)) ? Number(raw.token_count ?? raw.tokenCount) : Math.ceil(text.length / 4),
    contentHash,
  }
}

function splitCanonicalChunk(chunk, maxChars) {
  if (chunk.text.length <= maxChars) return [chunk]
  const pieces = splitByLines(chunk.text, maxChars)
  return pieces.map((text, index) => ({
    ...chunk,
    chunkId: `chunk-${sha256(`${chunk.chunkId}:${index}:${text}`).slice(0, 24)}`,
    text,
    tokenEstimate: Math.ceil(text.length / 4),
    contentHash: sha256(text),
    structuredData: (chunk.structuredData ?? []).map((item) => ({ ...item, markdown: text, text, fragmented: true, part: index + 1, parts: pieces.length })),
    retrievalViews: spreadsheetRetrievalViewsFromTable((chunk.structuredData ?? [])[0] ?? {}, text),
  }))
}

export function spreadsheetRetrievalViewsFromTable(table = {}, canonicalText) {
  const text = String(canonicalText ?? table.text ?? table.markdown ?? "")
  const sheet = table.sheetName ? `Sheet ${table.sheetName}` : ""
  const range = table.cellRange ? `Range ${table.cellRange}` : ""
  const views = []
  if (text.trim()) views.push({ view: "excel-block", title: [sheet, range, "table"].filter(Boolean).join(" / "), content: text })
  const formulas = Array.isArray(table.formulas) ? table.formulas : []
  if (formulas.length > 0) views.push({
    view: "excel-formula",
    title: [sheet, range, "formula"].filter(Boolean).join(" / "),
    content: [sheet, range, "Formula dependencies", formulas.map((formula) => `${formula.cell ?? formula.address}: ${formula.formula}${formula.cachedValue ?? formula.value ? ` => ${formula.cachedValue ?? formula.value}` : ""}`).join("\n")].filter(Boolean).join("\n"),
  })
  const namedRanges = Array.isArray(table.namedRanges) ? table.namedRanges : []
  if (namedRanges.length > 0) views.push({ view: "excel-named-range", title: `${sheet} named ranges`, content: `${sheet}\nNamed ranges: ${namedRanges.join(", ")}\n${range}` })
  const dependency = table.dependencySummary
  if (dependency && (dependency.upstream_refs?.length || dependency.downstream_refs?.length || dependency.cross_sheet_refs?.length)) {
    views.push({ view: "excel-dependency", title: `${sheet} dependencies`, content: `${sheet}\n${range}\n${dependencySummaryText(dependency)}` })
  }
  return views
}

function compactCell(value) {
  if (!value || typeof value !== "object") return null
  const address = boundedString(value.address ?? value.cell, 100)
  if (!address) return null
  return {
    address,
    value: boundedString(value.value ?? value.display_value ?? value.raw_value, 500),
    ...(boundedString(value.formula, 1_000) ? { formula: boundedString(value.formula, 1_000) } : {}),
  }
}

function compactDependency(value) {
  if (!value || typeof value !== "object") return null
  const result = {}
  for (const key of ["upstream_refs", "downstream_refs", "cross_sheet_refs"]) {
    const values = boundedArray(value[key], MAX_EXTERNAL_ARRAY_ITEMS).map((item) => boundedString(item, 300)).filter(Boolean)
    if (values.length > 0) result[key] = values
  }
  if (value.has_circular === true) result.has_circular = true
  return Object.keys(result).length > 0 ? result : null
}

function dependencySummaryText(value) {
  if (!value) return null
  const lines = []
  if (value.upstream_refs?.length) lines.push(`Upstream references: ${value.upstream_refs.join(", ")}`)
  if (value.downstream_refs?.length) lines.push(`Downstream references: ${value.downstream_refs.join(", ")}`)
  if (value.cross_sheet_refs?.length) lines.push(`Cross-sheet references: ${value.cross_sheet_refs.join(", ")}`)
  if (value.has_circular) lines.push("Circular dependency: true")
  return lines.length > 0 ? `Dependencies:\n${lines.join("\n")}` : null
}

function compactWorkbookMetadata(workbook) {
  return {
    workbookId: boundedString(workbook.workbook_id ?? workbook.workbookId, 200),
    filename: path.basename(boundedString(workbook.filename, 300)),
    workbookHash: boundedString(workbook.workbook_hash ?? workbook.workbookHash, 100),
    totalSheets: Number(workbook.total_sheets ?? workbook.totalSheets) || 0,
    totalCells: Number(workbook.total_cells ?? workbook.totalCells) || 0,
    totalFormulas: Number(workbook.total_formulas ?? workbook.totalFormulas) || 0,
    namedRanges: boundedArray(workbook.named_ranges ?? workbook.namedRanges, MAX_EXTERNAL_ARRAY_ITEMS).map((item) => compactObject(item, 8)),
    kpiCatalog: boundedArray(workbook.kpi_catalog ?? workbook.kpiCatalog, MAX_EXTERNAL_ARRAY_ITEMS).map((item) => compactObject(item, 8)),
    dependencyEdges: boundedArray(workbook.dependency_edges ?? workbook.dependencyEdges, MAX_EXTERNAL_ARRAY_ITEMS).map((item) => compactObject(item, 8)),
  }
}

function parseSourceUri(value) {
  const source = String(value || "")
  const marker = source.lastIndexOf("#")
  const fragment = marker >= 0 ? source.slice(marker + 1) : source
  const separator = fragment.lastIndexOf("!")
  if (separator < 0) return {}
  const sheetName = fragment.slice(0, separator).replace(/^'+|'+$/g, "").replace(/''/g, "'")
  const cellRange = fragment.slice(separator + 1).replace(/\$/g, "")
  return { sheetName: sheetName || undefined, cellRange: /^[A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*$/i.test(cellRange) ? cellRange : undefined }
}

function boundedString(value, maximum) {
  if (value === undefined || value === null) return ""
  return String(value).replace(/\0/g, "").slice(0, maximum)
}

function boundedArray(value, maximum) {
  return Array.isArray(value) ? value.slice(0, maximum) : []
}

function compactObject(value, depth = 8) {
  if (!value || typeof value !== "object" || depth <= 0) return {}
  if (Array.isArray(value)) return value.slice(0, MAX_EXTERNAL_ARRAY_ITEMS).map((item) => compactObject(item, depth - 1))
  const result = {}
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    if (/(^|_)(path|file|uri)(_|$)/i.test(key)) continue
    if (typeof item === "string") result[key] = boundedString(item, MAX_EXTERNAL_STRING_CHARS)
    else if (typeof item === "number" || typeof item === "boolean" || item === null) result[key] = item
    else if (typeof item === "object") result[key] = compactObject(item, depth - 1)
  }
  return result
}

function boundedDiagnostics(value) {
  return boundedArray(value, 64).map((item) => compactObject(item, 4)).filter((item) => Object.keys(item).length > 0)
}

function safeTitle(value) {
  return String(value || "Workbook").replace(/\.[^.]+$/, "").replace(/[\r\n]+/g, " ").trim().slice(0, 500) || "Workbook"
}

function splitByLines(value, maxChars) {
  const pieces = []
  let current = ""
  for (const line of String(value).split("\n")) {
    if (current && current.length + line.length + 1 > maxChars) {
      pieces.push(current)
      current = ""
    }
    if (line.length > maxChars) {
      if (current) pieces.push(current)
      for (let index = 0; index < line.length; index += maxChars) pieces.push(line.slice(index, index + maxChars))
      current = ""
    } else current = current ? `${current}\n${line}` : line
  }
  if (current) pieces.push(current)
  return pieces.length > 0 ? pieces : [String(value).slice(0, maxChars)]
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback
}

function compactDiagnostic(error) {
  return {
    code: error?.code ?? "EXCEL_PARSER_FAILED",
    message: String(error?.message ?? error).slice(0, 500),
    fallback: "native",
  }
}

function normalizeParserError(error) {
  if (error instanceof LlmWikiError) return error
  return new LlmWikiError("EXCEL_PARSER_FAILED", String(error), { retryable: true })
}
