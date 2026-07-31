import { lstat } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"
import { stableStringify, tokenize } from "./utils.js"

const ANALYSIS_ARRAYS = ["sourceRefs", "entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems", "unresolvedQuestions"]
const GROUNDED_ANALYSIS_COLLECTIONS = new Set(["entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems"])
const MAX_ANALYSIS_VALIDATION_ERRORS = 50
const MAX_SOURCE_REF_REUSE = 8
const GROUNDING_QUALITY_COLLECTIONS = new Set(["claims", "relations", "contradictions", "reviewItems"])
const GENERIC_GROUNDING_TERMS = new Set(["content", "data", "document", "item", "内容", "数据", "文档", "指标", "体系", "关系", "概述", "包含", "包括"])
const ALLOWED_PAGE_ROOTS = new Set(["sources", "entities", "concepts", "topics", "comparisons"])
const SYSTEM_PAGES = new Set(["wiki/index.md", "wiki/overview.md", "wiki/log.md"])

export function normalizeAnalysisEnvelope(analysis) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    return { analysis, resolvedSourceRefIndexes: 0 }
  }
  const catalog = Array.isArray(analysis.sourceRefs) ? analysis.sourceRefs : []
  const errors = []
  let resolvedSourceRefIndexes = 0
  const normalized = { ...analysis }
  for (const collection of GROUNDED_ANALYSIS_COLLECTIONS) {
    if (!Array.isArray(analysis[collection])) continue
    normalized[collection] = analysis[collection].map((item, itemIndex) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || !Array.isArray(item.sourceRefs)) return item
      const sourceRefs = item.sourceRefs.map((ref, refIndex) => {
        if (typeof ref !== "number") return ref
        const field = `${collection}[${itemIndex}].sourceRefs[${refIndex}]`
        if (!Number.isInteger(ref) || ref < 0) {
          errors.push(`${field} must be a non-negative integer index or a complete SourceRef object`)
          return ref
        }
        if (ref >= catalog.length) {
          errors.push(`${field} index ${ref} is out of range for top-level sourceRefs length ${catalog.length}`)
          return ref
        }
        resolvedSourceRefIndexes += 1
        return catalog[ref]
      })
      return { ...item, sourceRefs }
    })
  }
  if (errors.length > 0) {
    fail("INVALID_ANALYSIS", "Analysis SourceRef normalization failed.", {
      details: { validation_errors: errors.slice(0, MAX_ANALYSIS_VALIDATION_ERRORS), validation_error_count: errors.length },
    })
  }
  return { analysis: normalized, resolvedSourceRefIndexes }
}

export function validateAnalysisShape(analysis, taskId, batchId) {
  const errors = []
  let errorCount = 0
  const addError = (message) => {
    errorCount += 1
    if (errors.length < MAX_ANALYSIS_VALIDATION_ERRORS) errors.push(message)
  }
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) addError("analysis must be an object, not a serialized JSON string or array")
  else {
    if (analysis.schemaVersion !== 1) addError("schemaVersion must be 1")
    if (analysis.taskId !== taskId) addError("taskId does not match the task")
    if (analysis.batchId !== batchId) addError("batchId does not match the batch")
    for (const key of ANALYSIS_ARRAYS) if (!Array.isArray(analysis[key])) addError(`${key} must be an array`)
    if (typeof analysis.batchSummary !== "string") addError("batchSummary must be a string")
    if (Array.isArray(analysis.unresolvedQuestions)) {
      analysis.unresolvedQuestions.forEach((item, index) => {
        if (typeof item !== "string") addError(`unresolvedQuestions[${index}] must be a string`)
      })
    }
    const catalog = new Set()
    if (Array.isArray(analysis.sourceRefs)) {
      if (analysis.sourceRefs.length === 0) addError("sourceRefs must not be empty")
      analysis.sourceRefs.forEach((ref, index) => {
        if (!isSourceRefObject(ref)) addError(`sourceRefs[${index}] must be a complete SourceRef object`)
        else catalog.add(stableStringify(ref))
      })
    }
    const localIds = new Set()
    for (const collection of ["entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems"]) {
      for (const [itemIndex, item] of (Array.isArray(analysis[collection]) ? analysis[collection] : []).entries()) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          addError(`${collection}[${itemIndex}] must be an object`)
          continue
        }
        const localId = item?.localId ?? item?.local_id
        if (typeof localId === "string") {
          if (localIds.has(localId)) addError(`duplicate local ID: ${localId}`)
          localIds.add(localId)
        }
        const confidence = item?.confidence
        if (confidence !== undefined && (typeof confidence !== "number" || confidence < 0 || confidence > 1)) {
          addError(`${collection}[${itemIndex}].confidence must be between 0 and 1`)
        }
        if (collection === "reviewItems" && (typeof item.content !== "string" || !item.content.trim())) {
          addError(`reviewItems[${itemIndex}].content must be a non-empty string`)
        }
        if (GROUNDED_ANALYSIS_COLLECTIONS.has(collection)) {
          if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length === 0) {
            addError(`${collection}[${itemIndex}].sourceRefs must contain at least one complete SourceRef object`)
          } else {
            item.sourceRefs.forEach((ref, refIndex) => {
              const field = `${collection}[${itemIndex}].sourceRefs[${refIndex}]`
              if (!isSourceRefObject(ref)) addError(`${field} must be a complete SourceRef object after normalization`)
              else if (!catalog.has(stableStringify(ref))) addError(`${field} must also appear in the top-level sourceRefs catalog`)
            })
          }
        }
      }
    }
  }
  if (errorCount > errors.length) errors.push(`${errorCount - errors.length} additional validation errors were omitted`)
  if (errors.length > 0) fail("INVALID_ANALYSIS", "Analysis envelope validation failed.", { details: { validation_errors: errors, validation_error_count: errorCount } })
}

export function validateGroundingQuality(analysis) {
  const errors = []
  const refUses = new Map()
  for (const collection of GROUNDED_ANALYSIS_COLLECTIONS) {
    for (const [itemIndex, item] of (Array.isArray(analysis?.[collection]) ? analysis[collection] : []).entries()) {
      if (!item || typeof item !== "object" || !Array.isArray(item.sourceRefs)) continue
      for (const ref of item.sourceRefs) {
        if (!isSourceRefObject(ref)) continue
        const signature = stableStringify(ref)
        const current = refUses.get(signature) ?? { count: 0, paths: [] }
        current.count += 1
        if (current.paths.length < 3) current.paths.push(`${collection}[${itemIndex}]`)
        refUses.set(signature, current)
      }
      if (!GROUNDING_QUALITY_COLLECTIONS.has(collection)) continue
      const semanticText = candidateSemanticText(item)
      if (!semanticText) continue
      const evidenceText = item.sourceRefs
        .filter(isSourceRefObject)
        .map((ref) => typeof ref.quote === "string" ? ref.quote.trim() : "")
        .filter(Boolean)
        .join("\n")
      if (!evidenceText) {
        errors.push(`${collection}[${itemIndex}] requires a non-empty SourceRef quote that supports its content`)
      } else if (!evidenceSupportsCandidate(semanticText, evidenceText, item)) {
        errors.push(`${collection}[${itemIndex}] SourceRef quote does not lexically support the candidate content; cite the relevant row or passage`)
      }
    }
  }
  for (const { count, paths } of refUses.values()) {
    if (count > MAX_SOURCE_REF_REUSE) {
      errors.push(`one SourceRef is reused by ${count} grounded candidates (${paths.join(", ")}, ...); split evidence by row or topic (maximum ${MAX_SOURCE_REF_REUSE} uses per reference)`)
    }
  }
  if (errors.length > 0) {
    fail("INVALID_ANALYSIS", "Analysis grounding quality validation failed.", {
      details: {
        validation_errors: errors.slice(0, MAX_ANALYSIS_VALIDATION_ERRORS),
        validation_error_count: errors.length,
        quality_gate: "source-ref-grounding-v1",
      },
    })
  }
}

function candidateSemanticText(item) {
  return [item.name, item.title, item.text, item.content, item.subject, item.predicate, item.object]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ")
}

function evidenceSupportsCandidate(semanticText, evidenceText, item) {
  const normalizedEvidence = evidenceText.normalize("NFKC").toLowerCase()
  for (const label of [item.name, item.title, item.text]) {
    if (typeof label !== "string") continue
    const normalizedLabel = label.normalize("NFKC").toLowerCase().trim()
    if (normalizedLabel.length >= 3 && normalizedEvidence.includes(normalizedLabel)) return true
  }
  const semanticTerms = tokenize(semanticText).filter((term) => !GENERIC_GROUNDING_TERMS.has(term))
  const evidenceTerms = new Set(tokenize(evidenceText).filter((term) => !GENERIC_GROUNDING_TERMS.has(term)))
  if (semanticTerms.length === 0 || evidenceTerms.size === 0) return false
  const overlap = semanticTerms.filter((term) => evidenceTerms.has(term)).length
  return overlap >= 2 && overlap / semanticTerms.length >= 0.5
}

function isSourceRefObject(ref) {
  return Boolean(ref && typeof ref === "object" && !Array.isArray(ref) && typeof ref.sourceId === "string" && typeof ref.chunkId === "string")
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
