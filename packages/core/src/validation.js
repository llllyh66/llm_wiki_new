import { lstat } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"
import { stableStringify, tokenize } from "./utils.js"
import { AGENT_PAGE_ROOTS, normalizePageKind, pageKindForPath } from "./wiki-page.js"

const ANALYSIS_ARRAYS = ["sourceRefs", "entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems", "unresolvedQuestions"]
const GROUNDED_ANALYSIS_COLLECTIONS = new Set(["entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems"])
const MAX_ANALYSIS_VALIDATION_ERRORS = 50
const MAX_SOURCE_REF_REUSE = 8
const GROUNDING_QUALITY_COLLECTIONS = new Set(["claims", "relations", "contradictions", "reviewItems"])
const GENERIC_GROUNDING_TERMS = new Set(["content", "data", "document", "item", "内容", "数据", "文档", "指标", "体系", "关系", "概述", "包含", "包括"])
const ALLOWED_PAGE_ROOTS = new Set(AGENT_PAGE_ROOTS)
const SYSTEM_PAGES = new Set(["wiki/index.md", "wiki/overview.md", "wiki/log.md"])
const ANALYSIS_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion", "taskId", "batchId", "sourceRefs", "sourceRefMode", "entities", "concepts",
  "claims", "relations", "contradictions", "candidatePages", "reviewItems", "batchSummary", "unresolvedQuestions",
])
const ANALYSIS_ARRAY_LIMITS = Object.freeze({ sourceRefs: 500, entities: 500, concepts: 500, claims: 1_000, relations: 1_000, contradictions: 500, candidatePages: 500, reviewItems: 500, unresolvedQuestions: 200 })
const PAGE_PATCH_FIELDS = new Set(["patchId", "path", "operation", "expectedFileHash", "title", "pageKind", "content", "summary", "tags", "related", "covers", "sourceRefs", "rationale"])

export function normalizeAnalysisEnvelope(analysis, options = {}) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    return { analysis, resolvedSourceRefIndexes: 0 }
  }
  if (analysis.sourceRefMode === "batch-evidence-index") {
    return normalizeBatchEvidenceEnvelope(analysis, options.evidenceCatalog)
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

function normalizeBatchEvidenceEnvelope(analysis, evidenceCatalog) {
  const available = Array.isArray(evidenceCatalog) ? evidenceCatalog : []
  const errors = []
  const used = []
  const seen = new Set()
  let resolvedSourceRefIndexes = 0
  const addUsed = (ref) => {
    const signature = stableStringify(ref)
    if (!seen.has(signature)) {
      seen.add(signature)
      used.push(ref)
    }
    return ref
  }
  const resolveEvidenceIndex = (ref, field) => {
    if (typeof ref !== "number") return isSourceRefObject(ref) ? addUsed(ref) : ref
    if (!Number.isInteger(ref) || ref < 0 || ref >= available.length) {
      errors.push(`${field} evidence index ${ref} is out of range for evidence_catalog length ${available.length}`)
      return ref
    }
    resolvedSourceRefIndexes += 1
    return addUsed(available[ref])
  }
  if (!Array.isArray(analysis.sourceRefs)) {
    errors.push("sourceRefs must be the numeric catalog copied from analysis_scaffold")
  } else {
    analysis.sourceRefs.forEach((ref, index) => {
      if (typeof ref !== "number" && !isSourceRefObject(ref)) {
        errors.push(`sourceRefs[${index}] must be an evidence index or a complete SourceRef object`)
      } else if (typeof ref === "number" && (!Number.isInteger(ref) || ref < 0 || ref >= available.length)) {
        errors.push(`sourceRefs[${index}] evidence index ${ref} is out of range for evidence_catalog length ${available.length}`)
      }
    })
  }
  const normalized = { ...analysis }
  delete normalized.sourceRefMode
  for (const collection of GROUNDED_ANALYSIS_COLLECTIONS) {
    if (!Array.isArray(analysis[collection])) continue
    normalized[collection] = analysis[collection].map((item, itemIndex) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || !Array.isArray(item.sourceRefs)) return item
      return {
        ...item,
        sourceRefs: item.sourceRefs.map((ref, refIndex) => resolveEvidenceIndex(
          ref,
          `${collection}[${itemIndex}].sourceRefs[${refIndex}]`,
        )),
      }
    })
  }
  if (used.length === 0 && Array.isArray(analysis.sourceRefs) && analysis.sourceRefs.length > 0) {
    const fallback = resolveEvidenceIndex(analysis.sourceRefs[0], "sourceRefs[0]")
    if (isSourceRefObject(fallback)) addUsed(fallback)
  }
  normalized.sourceRefs = used
  if (errors.length > 0) {
    fail("INVALID_ANALYSIS", "Analysis batch evidence normalization failed.", {
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
    for (const key of Object.keys(analysis)) if (!ANALYSIS_TOP_LEVEL_FIELDS.has(key)) addError(`analysis contains unsupported field: ${key}`)
    if (analysis.schemaVersion !== 1) addError("schemaVersion must be 1")
    if (analysis.taskId !== taskId) addError("taskId does not match the task")
    if (analysis.batchId !== batchId) addError("batchId does not match the batch")
    for (const key of ANALYSIS_ARRAYS) {
      if (!Array.isArray(analysis[key])) addError(`${key} must be an array`)
      else if (analysis[key].length > ANALYSIS_ARRAY_LIMITS[key]) addError(`${key} exceeds ${ANALYSIS_ARRAY_LIMITS[key]} items`)
    }
    if (typeof analysis.batchSummary !== "string") addError("batchSummary must be a string")
    else if (analysis.batchSummary.length > 20_000) addError("batchSummary exceeds 20000 characters")
    if (Array.isArray(analysis.unresolvedQuestions)) {
      analysis.unresolvedQuestions.forEach((item, index) => {
        if (typeof item !== "string") addError(`unresolvedQuestions[${index}] must be a string`)
        else if (item.length > 2_000) addError(`unresolvedQuestions[${index}] exceeds 2000 characters`)
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
        } else if (collection === "reviewItems" && item.content.length > 10_000) {
          addError(`reviewItems[${itemIndex}].content exceeds 10000 characters`)
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
  const normalizedEvidence = normalizeGroundingText(evidenceText)
  const evidenceTerms = new Set(groundingTerms(evidenceText))
  // Schema relation names can be long canonical identifiers which are not
  // expected to occur verbatim in source prose. Judge the actual assertion
  // independently first so a directly quoted fact cannot be diluted by its
  // classification label (for example, a billing-account relation type).
  for (const assertion of candidateAssertionTexts(item)) {
    const normalizedAssertion = normalizeGroundingText(assertion)
    if (normalizedAssertion.length >= 3 && normalizedEvidence.includes(normalizedAssertion)) return true
    if (groundingTermsSupported(assertion, evidenceTerms)) return true
  }
  for (const label of [item.name, item.title, item.text]) {
    if (typeof label !== "string") continue
    const normalizedLabel = normalizeGroundingText(label)
    if (normalizedLabel.length >= 3 && normalizedEvidence.includes(normalizedLabel)) return true
  }
  const semanticTerms = groundingTerms(semanticText)
  if (semanticTerms.length === 0 || evidenceTerms.size === 0) return false
  const overlap = semanticTerms.filter((term) => evidenceTerms.has(term)).length
  return overlap >= 2 && overlap / semanticTerms.length >= 0.5
}

function candidateAssertionTexts(item) {
  const values = [item.content, item.text]
  const relationTuple = [item.subject, item.predicate, item.object]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ")
  if (relationTuple) values.push(relationTuple)
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))]
}

function groundingTerms(value) {
  return tokenize(value).filter((term) => !GENERIC_GROUNDING_TERMS.has(term))
}

function groundingTermsSupported(value, evidenceTerms) {
  const terms = groundingTerms(value)
  if (terms.length < 2 || evidenceTerms.size === 0) return false
  const overlap = terms.filter((term) => evidenceTerms.has(term)).length
  return overlap >= 2 && overlap / terms.length >= 0.5
}

function normalizeGroundingText(value) {
  return value.normalize("NFKC")
    .toLowerCase()
    .replace(/[\*`~]/gu, "")
    .replace(/[“”„‟＂]/gu, '"')
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
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

export function canonicalizeAnalysisSourceRefQuotes(analysis, batches, chunkIndex) {
  const chunks = chunkIndex instanceof Map
    ? chunkIndex
    : new Map((Array.isArray(batches) ? batches : [])
      .flatMap((batch) => Array.isArray(batch?.chunks) ? batch.chunks : [])
      .map((chunk) => [chunk.chunkId, chunk]))
  const visited = new WeakSet()
  let repaired = 0
  function visit(current, key) {
    if (!current || typeof current !== "object") return
    if (Array.isArray(current)) {
      if (key === "sourceRefs") {
        for (const ref of current) {
          if (!isSourceRefObject(ref) || visited.has(ref) || typeof ref.quote !== "string" || !ref.quote) continue
          visited.add(ref)
          const source = chunks.get(ref.chunkId)?.text
          if (typeof source !== "string" || source.includes(ref.quote)) continue
          const canonical = uniquelyMatchedOriginalQuote(source, ref.quote)
          if (canonical && canonical !== ref.quote) {
            ref.quote = canonical
            repaired += 1
          }
        }
        return
      }
      current.forEach((item) => visit(item))
      return
    }
    Object.entries(current).forEach(([childKey, item]) => visit(item, childKey))
  }
  visit(analysis)
  return repaired
}

function uniquelyMatchedOriginalQuote(source, quote) {
  for (const relaxed of [false, true]) {
    const sourceIndex = normalizedEvidenceWithOffsets(source, relaxed)
    const needle = normalizedEvidenceWithOffsets(quote, relaxed).text
    if (!needle) continue
    const first = sourceIndex.text.indexOf(needle)
    if (first < 0 || sourceIndex.text.indexOf(needle, first + 1) >= 0) continue
    const start = sourceIndex.starts[first]
    const end = sourceIndex.ends[first + needle.length - 1]
    if (Number.isInteger(start) && Number.isInteger(end) && end > start) return source.slice(start, end)
  }
  return null
}

function normalizedEvidenceWithOffsets(value, relaxed) {
  let text = ""
  const starts = []
  const ends = []
  let pendingWhitespace = null
  const append = (character, start, end) => {
    text += character
    starts.push(start)
    ends.push(end)
  }
  for (let index = 0; index < value.length;) {
    const codePoint = String.fromCodePoint(value.codePointAt(index))
    const end = index + codePoint.length
    for (let character of codePoint.normalize("NFKC")) {
      if (/\s/u.test(character)) {
        pendingWhitespace ??= { start: index, end }
        pendingWhitespace.end = end
        continue
      }
      if (pendingWhitespace && text && !text.endsWith(" ")) append(" ", pendingWhitespace.start, pendingWhitespace.end)
      pendingWhitespace = null
      if (relaxed && (character === "*" || character === "`")) continue
      if (relaxed && /[“”„‟＂]/u.test(character)) character = '"'
      if (relaxed && /[‘’‚‛]/u.test(character)) character = "'"
      append(character, index, end)
    }
    index = end
  }
  return { text: text.trim(), starts, ends }
}

export function validateSourceRefs(refs, task, batches, limits, chunkIndex) {
  if (!Array.isArray(refs)) fail("INVALID_SOURCE_REF", "sourceRefs must be an array.")
  const sourceIds = new Set(task.sourceIds)
  const chunks = chunkIndex instanceof Map
    ? chunkIndex
    : new Map(batches.flatMap((batch) => batch.chunks).map((chunk) => [chunk.chunkId, chunk]))
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
      if (quote && !source.includes(quote)) {
        fail("INVALID_SOURCE_REF", `Quote does not match chunk ${ref.chunkId}.`, {
          retryable: true,
          details: {
            chunk_id: ref.chunkId,
            rejected_quote: ref.quote.slice(0, 200),
            repair: "Copy an exact SourceRef object from the page requirement or leased batch; do not retype or paraphrase its quote.",
          },
        })
      }
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
      if (startOffset !== undefined && Number.isInteger(chunk.startOffset) && startOffset !== chunk.startOffset) {
        fail("INVALID_SOURCE_REF", `locator.startOffset does not match chunk ${ref.chunkId}; copy an exact source_ref_templates value.`, {
          retryable: true,
          details: { expected_start_offset: chunk.startOffset },
        })
      }
      if (endOffset !== undefined && Number.isInteger(chunk.endOffset) && endOffset !== chunk.endOffset) {
        fail("INVALID_SOURCE_REF", `locator.endOffset does not match chunk ${ref.chunkId}; copy an exact source_ref_templates value.`, {
          retryable: true,
          details: { expected_end_offset: chunk.endOffset },
        })
      }
      if (page !== undefined && Number.isInteger(chunk.pageNumber) && page !== chunk.pageNumber) {
        fail("INVALID_SOURCE_REF", `locator.page does not match chunk ${ref.chunkId}; copy an exact source_ref_templates value.`, {
          retryable: true,
          details: { expected_page: chunk.pageNumber },
        })
      }
      if (headingPath !== undefined && Array.isArray(chunk.headingPath)
        && stableStringify(headingPath) !== stableStringify(chunk.headingPath)) {
        fail("INVALID_SOURCE_REF", `locator.headingPath does not match chunk ${ref.chunkId}; copy an exact source_ref_templates value.`, {
          retryable: true,
          details: { expected_heading_path: chunk.headingPath },
        })
      }
      const structuredTables = Array.isArray(chunk.structuredData) ? chunk.structuredData : []
      const allowedSheetNames = [...new Set([chunk.sheetName, ...structuredTables.map((table) => table.sheetName)].filter((value) => typeof value === "string"))]
      const allowedCellRanges = [...new Set([chunk.cellRange, ...structuredTables.map((table) => table.cellRange)].filter((value) => typeof value === "string"))]
      if (sheetName !== undefined && !allowedSheetNames.includes(sheetName)) {
        fail("INVALID_SOURCE_REF", `locator.sheetName ${JSON.stringify(sheetName)} does not match chunk ${ref.chunkId}; copy an exact chunk.source_ref_templates value.`, {
          retryable: true,
          details: { allowed_sheet_names: allowedSheetNames },
        })
      }
      if (cellRange !== undefined && !allowedCellRanges.includes(cellRange)) {
        fail("INVALID_SOURCE_REF", `locator.cellRange ${JSON.stringify(cellRange)} does not match chunk ${ref.chunkId}; copy an exact chunk.source_ref_templates value.`, {
          retryable: true,
          details: { allowed_cell_ranges: allowedCellRanges },
        })
      }
    }
  }
}

function normalizeQuote(value) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim()
}

export function validatePagePatchShape(patch, limits) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) fail("INVALID_PAGE_PATCH", "Each patch must be an object.")
  for (const key of Object.keys(patch)) if (!PAGE_PATCH_FIELDS.has(key)) fail("INVALID_PAGE_PATCH", `Patch contains unsupported field: ${key}`)
  for (const key of ["patchId", "path", "operation", "title", "pageKind", "content", "rationale"]) {
    if (typeof patch[key] !== "string" || !patch[key].trim()) fail("INVALID_PAGE_PATCH", `Patch ${key} is required.`)
  }
  if (!new Set(["create", "replace", "merge"]).has(patch.operation)) fail("INVALID_PAGE_PATCH", `Unsupported page operation: ${patch.operation}`)
  if (!Array.isArray(patch.sourceRefs) || patch.sourceRefs.length === 0) fail("INVALID_PAGE_PATCH", "Every page patch requires at least one SourceRef.")
  if (patch.sourceRefs.length > 500) fail("INVALID_PAGE_PATCH", "Patch sourceRefs exceeds 500 items.")
  if (patch.patchId.length > 200) fail("INVALID_PAGE_PATCH", "Patch patchId exceeds 200 characters.")
  if (patch.title.length > 500) fail("INVALID_PAGE_PATCH", "Patch title exceeds 500 characters.")
  if (patch.pageKind.length > 100) fail("INVALID_PAGE_PATCH", "Patch pageKind exceeds 100 characters.")
  if (patch.rationale.length > 10_000) fail("INVALID_PAGE_PATCH", "Patch rationale exceeds 10000 characters.")
  const arrayLimits = { tags: [100, 200], related: [500, 500], covers: [1_000, 300] }
  for (const field of ["tags", "related", "covers"]) {
    if (patch[field] !== undefined && (!Array.isArray(patch[field]) || patch[field].some((value) => typeof value !== "string" || !value.trim()))) {
      fail("INVALID_PAGE_PATCH", `Patch ${field} must be an array of non-empty strings.`)
    }
    if (Array.isArray(patch[field])) {
      const [maximumItems, maximumChars] = arrayLimits[field]
      if (patch[field].length > maximumItems || patch[field].some((value) => value.length > maximumChars)) {
        fail("INVALID_PAGE_PATCH", `Patch ${field} exceeds its count or item-length limit.`)
      }
    }
  }
  if (patch.summary !== undefined && (typeof patch.summary !== "string" || patch.summary.length > 500)) fail("INVALID_PAGE_PATCH", "Patch summary must not exceed 500 characters.")
  validatePagePath(patch.path)
  const normalizedKind = normalizePageKind(patch.pageKind)
  const pathKind = pageKindForPath(patch.path)
  if (!normalizedKind || !pathKind || normalizedKind !== pathKind) fail("INVALID_PAGE_PATCH", "pageKind must match the Wiki collection in path.")
  if (patch.content.length > limits.maxPageChars) fail("INVALID_PAGE_PATCH", "Page content exceeds the workspace limit.")
  if (patch.expectedFileHash !== undefined && !/^[0-9a-f]{64}$/i.test(patch.expectedFileHash)) fail("INVALID_PAGE_PATCH", "expectedFileHash must be a SHA256 value.")
}

export function normalizePagePatchSourceRefs(patch, requirements) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Array.isArray(patch.sourceRefs)) {
    return { patch, resolvedRequirementSourceRefs: 0 }
  }
  const lookup = new Map((Array.isArray(requirements) ? requirements : [])
    .map((requirement) => [requirement?.requirement_id, requirement]))
  const resolved = []
  let resolvedRequirementSourceRefs = 0
  for (const [index, ref] of patch.sourceRefs.entries()) {
    if (typeof ref !== "string") {
      resolved.push(ref)
      continue
    }
    const requirement = lookup.get(ref)
    if (!requirement) {
      fail("INVALID_PAGE_PATCH", `sourceRefs[${index}] requirement ID ${JSON.stringify(ref)} is not part of the current page plan.`, {
        retryable: true,
        details: { invalid_requirement_id: ref },
        suggestedAction: "Copy sourceRefs from page_requirement.patch_scaffold; do not copy or rewrite complete SourceRef objects.",
      })
    }
    const refs = Array.isArray(requirement.source_refs) ? requirement.source_refs : []
    if (refs.length === 0) {
      fail("INVALID_PAGE_PATCH", `Page requirement ${ref} has no grounded SourceRefs.`, {
        retryable: true,
        suggestedAction: "Restart page-plan collection at cursor zero so Core can rebuild the requirement scaffold.",
      })
    }
    resolved.push(...refs)
    resolvedRequirementSourceRefs += refs.length
  }
  return {
    patch: { ...patch, sourceRefs: uniqueSourceRefs(resolved) },
    resolvedRequirementSourceRefs,
  }
}

function uniqueSourceRefs(refs) {
  const seen = new Set()
  return refs.filter((ref) => {
    const signature = stableStringify(ref)
    if (seen.has(signature)) return false
    seen.add(signature)
    return true
  })
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
