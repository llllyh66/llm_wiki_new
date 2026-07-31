import { lstat } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"

const ANALYSIS_ARRAYS = ["sourceRefs", "entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems", "unresolvedQuestions"]
const ALLOWED_PAGE_ROOTS = new Set(["sources", "entities", "concepts", "topics", "comparisons"])
const SYSTEM_PAGES = new Set(["wiki/index.md", "wiki/overview.md", "wiki/log.md"])

export function validateAnalysisShape(analysis, taskId, batchId) {
  const errors = []
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) errors.push("analysis must be an object")
  else {
    if (analysis.schemaVersion !== 1) errors.push("schemaVersion must be 1")
    if (analysis.taskId !== taskId) errors.push("taskId does not match the task")
    if (analysis.batchId !== batchId) errors.push("batchId does not match the batch")
    for (const key of ANALYSIS_ARRAYS) if (!Array.isArray(analysis[key])) errors.push(`${key} must be an array`)
    if (typeof analysis.batchSummary !== "string") errors.push("batchSummary must be a string")
    const localIds = new Set()
    for (const collection of ["entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems"]) {
      for (const item of Array.isArray(analysis[collection]) ? analysis[collection] : []) {
        if (!item || typeof item !== "object" || Array.isArray(item)) errors.push(`${collection} entries must be objects`)
        const localId = item?.localId ?? item?.local_id
        if (typeof localId === "string") {
          if (localIds.has(localId)) errors.push(`duplicate local ID: ${localId}`)
          localIds.add(localId)
        }
        const confidence = item?.confidence
        if (confidence !== undefined && (typeof confidence !== "number" || confidence < 0 || confidence > 1)) {
          errors.push(`${collection} confidence must be between 0 and 1`)
        }
        if (["entities", "concepts", "claims", "relations", "candidatePages"].includes(collection)
          && (!Array.isArray(item?.sourceRefs) || item.sourceRefs.length === 0)) {
          errors.push(`${collection} entries require sourceRefs`)
        }
      }
    }
    if (Array.isArray(analysis.sourceRefs) && analysis.sourceRefs.length === 0) errors.push("sourceRefs must not be empty")
  }
  if (errors.length > 0) fail("INVALID_ANALYSIS", "Analysis envelope validation failed.", { details: { validation_errors: errors } })
}

export function collectSourceRefs(value) {
  const refs = []
  const seen = new Set()
  function visit(current, key) {
    if (!current || typeof current !== "object") return
    if (key === "sourceRefs" && Array.isArray(current)) {
      for (const ref of current) {
        const signature = JSON.stringify(ref)
        if (!seen.has(signature)) {
          refs.push(ref)
          seen.add(signature)
        }
      }
      return
    }
    if (Array.isArray(current)) current.forEach((item) => visit(item))
    else Object.entries(current).forEach(([childKey, item]) => visit(item, childKey))
  }
  visit(value)
  return refs
}

export function validateSourceRefs(refs, task, batches, limits) {
  if (!Array.isArray(refs)) fail("INVALID_SOURCE_REF", "sourceRefs must be an array.")
  const sourceIds = new Set(task.sourceIds)
  const chunks = new Map(batches.flatMap((batch) => batch.chunks).map((chunk) => [chunk.chunkId, chunk]))
  for (const ref of refs) {
    if (!ref || typeof ref !== "object" || typeof ref.sourceId !== "string" || typeof ref.chunkId !== "string") {
      fail("INVALID_SOURCE_REF", "Every SourceRef requires sourceId and chunkId.")
    }
    if (!sourceIds.has(ref.sourceId)) fail("INVALID_SOURCE_REF", `Source ${ref.sourceId} is not part of this task.`)
    const chunk = chunks.get(ref.chunkId)
    if (!chunk || chunk.sourceId !== ref.sourceId) fail("INVALID_SOURCE_REF", `Chunk ${ref.chunkId} does not belong to source ${ref.sourceId}.`)
    if (ref.quote !== undefined) {
      if (typeof ref.quote !== "string" || ref.quote.length > limits.maxQuoteChars) fail("INVALID_SOURCE_REF", "SourceRef quote is invalid or too long.")
      const quote = normalizeQuote(ref.quote)
      const source = normalizeQuote(chunk.text)
      if (quote && !source.includes(quote)) fail("INVALID_SOURCE_REF", `Quote does not match chunk ${ref.chunkId}.`)
    }
    if (ref.locator !== undefined) {
      if (!ref.locator || typeof ref.locator !== "object" || Array.isArray(ref.locator)) fail("INVALID_SOURCE_REF", "SourceRef locator must be an object.")
      const { startOffset, endOffset, page, headingPath, sheetName, cellRange } = ref.locator
      if (startOffset !== undefined && (!Number.isInteger(startOffset) || startOffset < 0)) fail("INVALID_SOURCE_REF", "locator.startOffset must be a non-negative integer.")
      if (endOffset !== undefined && (!Number.isInteger(endOffset) || endOffset < 0 || (startOffset !== undefined && endOffset < startOffset))) fail("INVALID_SOURCE_REF", "locator.endOffset is invalid.")
      if (page !== undefined && (!Number.isInteger(page) || page < 1)) fail("INVALID_SOURCE_REF", "locator.page must be a positive integer.")
      if (headingPath !== undefined && (!Array.isArray(headingPath) || headingPath.some((part) => typeof part !== "string"))) fail("INVALID_SOURCE_REF", "locator.headingPath must be a string array.")
      if (sheetName !== undefined && (typeof sheetName !== "string" || !sheetName.trim() || sheetName.length > 500)) fail("INVALID_SOURCE_REF", "locator.sheetName must be a non-empty bounded string.")
      if (cellRange !== undefined && (typeof cellRange !== "string" || !/^[A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*$/i.test(cellRange))) fail("INVALID_SOURCE_REF", "locator.cellRange must be an A1-style range.")
      const structuredTables = Array.isArray(chunk.structuredData) ? chunk.structuredData : []
      if (sheetName !== undefined && ![chunk.sheetName, ...structuredTables.map((table) => table.sheetName)].includes(sheetName)) fail("INVALID_SOURCE_REF", "locator.sheetName does not match the source chunk.")
      if (cellRange !== undefined && ![chunk.cellRange, ...structuredTables.map((table) => table.cellRange)].includes(cellRange)) fail("INVALID_SOURCE_REF", "locator.cellRange does not match the source chunk.")
    }
  }
}

function normalizeQuote(value) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim()
}

export function validatePagePatchShape(patch, limits) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) fail("INVALID_PAGE_PATCH", "Each patch must be an object.")
  for (const key of ["patchId", "path", "operation", "title", "pageKind", "content", "rationale"]) {
    if (typeof patch[key] !== "string" || !patch[key].trim()) fail("INVALID_PAGE_PATCH", `Patch ${key} is required.`)
  }
  if (!new Set(["create", "replace", "merge"]).has(patch.operation)) fail("INVALID_PAGE_PATCH", `Unsupported page operation: ${patch.operation}`)
  if (!Array.isArray(patch.sourceRefs) || patch.sourceRefs.length === 0) fail("INVALID_PAGE_PATCH", "Every page patch requires at least one SourceRef.")
  if (patch.content.length > limits.maxPageChars) fail("INVALID_PAGE_PATCH", "Page content exceeds the workspace limit.")
  if (patch.expectedFileHash !== undefined && !/^[0-9a-f]{64}$/i.test(patch.expectedFileHash)) fail("INVALID_PAGE_PATCH", "expectedFileHash must be a SHA256 value.")
}

export function validatePagePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) fail("INVALID_PAGE_PATH", "Page path is invalid.")
  const normalized = relativePath.replace(/\\/g, "/")
  if (normalized !== relativePath || path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    fail("INVALID_PAGE_PATH", "Only normalized workspace-relative page paths are accepted.")
  }
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) fail("INVALID_PAGE_PATH", "Page path traversal is not allowed.")
  if (!normalized.toLowerCase().endsWith(".md")) fail("INVALID_PAGE_PATH", "Wiki pages must use the .md extension.")
  if (SYSTEM_PAGES.has(normalized)) fail("INVALID_PAGE_PATH", "Aggregate pages are maintained by the Core.")
  const parts = normalized.split("/")
  if (parts[0] !== "wiki" || !ALLOWED_PAGE_ROOTS.has(parts[1]) || parts.length < 3) fail("INVALID_PAGE_PATH", "Page path is outside an Agent-writable Wiki collection.")
  return normalized
}

export async function assertNoSymlinkEscape(root, relativePath) {
  const target = path.resolve(root, relativePath)
  const allowedPrefix = `${path.resolve(root)}${path.sep}`
  if (!target.startsWith(allowedPrefix)) fail("INVALID_PAGE_PATH", "Resolved page path escapes the workspace.")
  const parts = relativePath.split("/")
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) fail("INVALID_PAGE_PATH", "Page path crosses a symbolic link.")
      if (index < parts.length - 1 && !info.isDirectory()) fail("INVALID_PAGE_PATH", "A page path parent is not a directory.")
    } catch (error) {
      if (error?.code === "ENOENT") return target
      throw error
    }
  }
  return target
}
