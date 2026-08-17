import { lstat } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"
import { sha256, stableStringify, tokenize } from "./utils.js"
import { AGENT_PAGE_ROOTS, normalizePageKind, pageKindForPath } from "./wiki-page.js"

const ANALYSIS_ARRAYS = ["sourceRefs", "entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems", "unresolvedQuestions"]
const GROUNDED_ANALYSIS_COLLECTIONS = new Set(["entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems"])
const MAX_ANALYSIS_VALIDATION_ERRORS = 2_000
const SOURCE_REF_REUSE_WARNING_THRESHOLD = 8
const GROUNDING_QUALITY_COLLECTIONS = new Set(["entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems"])
const FACT_ASSERTION_COLLECTIONS = new Set(["entities", "concepts", "claims", "relations", "contradictions", "reviewItems"])
const GENERIC_GROUNDING_TERMS = new Set(["content", "data", "document", "item", "内容", "数据", "文档", "指标", "体系", "关系", "概述", "包含", "包括"])
const ALLOWED_PAGE_ROOTS = new Set(AGENT_PAGE_ROOTS)
const SYSTEM_PAGES = new Set(["wiki/index.md", "wiki/overview.md", "wiki/log.md"])
const ANALYSIS_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion", "taskId", "batchId", "sourceRefs", "sourceRefMode", "entities", "concepts",
  "claims", "relations", "contradictions", "candidatePages", "reviewItems", "batchSummary", "unresolvedQuestions",
])
const ANALYSIS_ARRAY_LIMITS = Object.freeze({ sourceRefs: 500, entities: 500, concepts: 500, claims: 1_000, relations: 1_000, contradictions: 500, candidatePages: 500, reviewItems: 500, unresolvedQuestions: 200 })
const PAGE_PATCH_FIELDS = new Set(["patchId", "path", "operation", "expectedFileHash", "title", "pageKind", "content", "sectionChanges", "summary", "domainSchemaId", "domainSchemaVersion", "domainClassifications", "tags", "related", "covers", "sourceRefs", "rationale"])
const CORE_OWNED_SECTION_HEADINGS = new Set(["related", "related pages", "相关页面", "关联页面", "domain classification", "领域分类", "领域类型"])

export function normalizeAnalysisEnvelope(analysis, options = {}) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    return { analysis, resolvedSourceRefIndexes: 0, normalizedUnresolvedQuestions: 0, normalizedNumericConfidences: 0, inferredBatchEvidenceMode: false }
  }
  const confidenceNormalization = normalizeNumericConfidenceStrings(analysis)
  const normalizedInput = confidenceNormalization.analysis
  const inferredBatchEvidenceMode = normalizedInput.sourceRefMode === undefined
    && Array.isArray(options.evidenceCatalog)
    && options.evidenceCatalog.length > 0
    && Array.isArray(normalizedInput.sourceRefs)
    && normalizedInput.sourceRefs.length > 0
    && normalizedInput.sourceRefs.every((ref) => Number.isInteger(ref) && ref >= 0 && ref < options.evidenceCatalog.length)
  if (normalizedInput.sourceRefMode === "batch-evidence-index" || inferredBatchEvidenceMode) {
    const normalized = normalizeBatchEvidenceEnvelope(
      inferredBatchEvidenceMode ? { ...normalizedInput, sourceRefMode: "batch-evidence-index" } : normalizedInput,
      options.evidenceCatalog,
    )
    return { ...normalized, normalizedNumericConfidences: confidenceNormalization.normalized, inferredBatchEvidenceMode }
  }
  const catalog = Array.isArray(normalizedInput.sourceRefs) ? normalizedInput.sourceRefs : []
  const errors = []
  let resolvedSourceRefIndexes = 0
  const unresolved = normalizeUnresolvedQuestions(normalizedInput.unresolvedQuestions)
  const normalized = { ...normalizedInput, ...(unresolved.value ? { unresolvedQuestions: unresolved.value } : {}) }
  for (const collection of GROUNDED_ANALYSIS_COLLECTIONS) {
    if (!Array.isArray(normalizedInput[collection])) continue
    normalized[collection] = normalizedInput[collection].map((item, itemIndex) => {
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
  return {
    analysis: normalized,
    resolvedSourceRefIndexes,
    normalizedUnresolvedQuestions: unresolved.normalized,
    normalizedNumericConfidences: confidenceNormalization.normalized,
    inferredBatchEvidenceMode: false,
  }
}

function normalizeNumericConfidenceStrings(analysis) {
  let normalized = 0
  const coerce = (value) => {
    if (typeof value !== "string" || !value.trim()) return value
    const trimmed = value.trim()
    if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(trimmed)) return value
    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) return value
    normalized += 1
    return numeric
  }
  const result = { ...analysis }
  for (const collection of GROUNDED_ANALYSIS_COLLECTIONS) {
    if (!Array.isArray(analysis[collection])) continue
    result[collection] = analysis[collection].map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item
      const candidate = { ...item }
      if (candidate.confidence !== undefined) candidate.confidence = coerce(candidate.confidence)
      for (const field of ["schemaClassification", "schema_classification"]) {
        if (!candidate[field] || typeof candidate[field] !== "object" || Array.isArray(candidate[field])) continue
        candidate[field] = { ...candidate[field] }
        if (candidate[field].confidence !== undefined) candidate[field].confidence = coerce(candidate[field].confidence)
      }
      return candidate
    })
  }
  return { analysis: result, normalized }
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
    if (typeof ref !== "number") return [isSourceRefObject(ref) ? addUsed(ref) : ref]
    if (!Number.isInteger(ref) || ref < 0 || ref >= available.length) {
      errors.push(`${field} evidence index ${ref} is out of range for evidence_catalog length ${available.length}`)
      return [ref]
    }
    resolvedSourceRefIndexes += 1
    const selected = Array.isArray(available[ref]) ? available[ref] : [available[ref]]
    return selected.map((item) => isSourceRefObject(item) ? addUsed(item) : item)
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
  const unresolved = normalizeUnresolvedQuestions(analysis.unresolvedQuestions)
  const normalized = { ...analysis, ...(unresolved.value ? { unresolvedQuestions: unresolved.value } : {}) }
  delete normalized.sourceRefMode
  for (const collection of GROUNDED_ANALYSIS_COLLECTIONS) {
    if (!Array.isArray(analysis[collection])) continue
    normalized[collection] = analysis[collection].map((item, itemIndex) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || !Array.isArray(item.sourceRefs)) return item
      return {
        ...item,
        sourceRefs: item.sourceRefs.flatMap((ref, refIndex) => resolveEvidenceIndex(
          ref,
          `${collection}[${itemIndex}].sourceRefs[${refIndex}]`,
        )),
      }
    })
  }
  if (used.length === 0 && Array.isArray(analysis.sourceRefs) && analysis.sourceRefs.length > 0) {
    resolveEvidenceIndex(analysis.sourceRefs[0], "sourceRefs[0]")
  }
  normalized.sourceRefs = used
  if (errors.length > 0) {
    fail("INVALID_ANALYSIS", "Analysis batch evidence normalization failed.", {
      details: { validation_errors: errors.slice(0, MAX_ANALYSIS_VALIDATION_ERRORS), validation_error_count: errors.length },
    })
  }
  return { analysis: normalized, resolvedSourceRefIndexes, normalizedUnresolvedQuestions: unresolved.normalized }
}

function normalizeUnresolvedQuestions(value) {
  if (!Array.isArray(value)) return { value, normalized: 0 }
  let normalized = 0
  const result = value.map((item) => {
    if (typeof item === "string" || !item || typeof item !== "object" || Array.isArray(item)) return item
    for (const field of ["question", "reason", "content", "message", "text"]) {
      if (typeof item[field] !== "string" || !item[field].trim()) continue
      normalized += 1
      return item[field].trim()
    }
    return item
  })
  return { value: result, normalized }
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

/**
 * Validate semantic grounding without requiring Wiki prose to be copied from
 * the source. SourceRef authenticity is handled by validateSourceRefs; this
 * gate only hard-fails on altered typed facts or a clear certainty/polarity
 * contradiction. Ordinary lexical mismatch is returned as a warning.
 */
export function validateGroundingQuality(analysis, options = {}) {
  const hardErrors = []
  const warnings = []
  let hardErrorCount = 0
  let warningCount = 0
  const refUses = new Map()
  const maxDiagnostics = Number.isInteger(options.maxDiagnostics) && options.maxDiagnostics > 0
    ? options.maxDiagnostics
    : MAX_ANALYSIS_VALIDATION_ERRORS

  const addDiagnostic = ({ collection, itemIndex, field, reasonCode, severity, observed, expected, sourceRefs, message }) => {
    const refs = (Array.isArray(sourceRefs) ? sourceRefs : []).filter(isSourceRefObject)
    const diagnostic = {
      path: `${collection}[${itemIndex}]${field ? `.${field}` : ""}`,
      field: field ?? null,
      reason_code: reasonCode,
      observed: boundDiagnosticValue(observed),
      expected: boundDiagnosticValue(expected),
      sourceRefs: refs.map(sourceRefDiagnostic),
      roles: refs.map((ref) => sourceRefRole(ref)),
      message: message ?? `${reasonCode} at ${collection}[${itemIndex}]`,
    }
    const target = severity === "warning" ? warnings : hardErrors
    if (severity === "warning") warningCount += 1
    else hardErrorCount += 1
    if (target.length < maxDiagnostics) target.push(diagnostic)
    return diagnostic
  }

  for (const collection of GROUNDED_ANALYSIS_COLLECTIONS) {
    for (const [itemIndex, item] of (Array.isArray(analysis?.[collection]) ? analysis[collection] : []).entries()) {
      if (!item || typeof item !== "object" || !Array.isArray(item.sourceRefs)) continue
      const refs = item.sourceRefs.filter(isSourceRefObject)
      const primaryRefs = refs.filter((ref) => sourceRefRole(ref) !== "context")
      for (const ref of primaryRefs) {
        const key = stableStringify({
          sourceId: ref.sourceId,
          chunkId: ref.chunkId,
          quote: ref.quote ?? null,
          locator: ref.locator ?? null,
          collection,
          context_group: sourceRefContextGroup(ref),
        })
        const current = refUses.get(key) ?? { count: 0, paths: [], ref }
        current.count += 1
        if (current.paths.length < 5) current.paths.push(`${collection}[${itemIndex}]`)
        refUses.set(key, current)
      }
      if (!GROUNDING_QUALITY_COLLECTIONS.has(collection)) continue
      const semanticText = candidateSemanticText(item, collection)
      const evidenceText = refs
        .map((ref) => typeof ref.quote === "string" ? ref.quote.trim() : "")
        .filter(Boolean)
        .join("\n")
      const primaryEvidenceText = primaryRefs
        .map((ref) => typeof ref.quote === "string" ? ref.quote.trim() : "")
        .filter(Boolean)
        .join("\n")
      // Legacy entity/concept envelopes sometimes cite a source_ref_template
      // without copying its quote. Keep those metadata-only candidates
      // compatible; claims, relations, contradictions, and review items still
      // require an auditable quote.
      if (!evidenceText && FACT_ASSERTION_COLLECTIONS.has(collection) && !["entities", "concepts"].includes(collection)) {
        addDiagnostic({
          collection,
          itemIndex,
          field: factFieldFor(collection, item),
          reasonCode: "MISSING_EVIDENCE_QUOTE",
          severity: "hard",
          observed: semanticText,
          expected: "a SourceRef with a non-empty quote",
          sourceRefs: refs,
          message: `${collection}[${itemIndex}] requires a non-empty SourceRef quote for its factual assertion`,
        })
        continue
      }
      if (!evidenceText) continue

      const assertionTexts = candidateAssertionTexts(item, collection)
      for (const assertion of assertionTexts) {
        const anchorReport = compareFactAnchors(assertion, evidenceText)
        for (const mismatch of anchorReport.mismatches) {
          addDiagnostic({
            collection,
            itemIndex,
            field: factFieldFor(collection, item),
            reasonCode: mismatch.reason_code,
            severity: "hard",
            observed: mismatch.observed,
            expected: mismatch.expected,
            sourceRefs: refs,
            message: `${collection}[${itemIndex}] ${mismatch.message}`,
          })
        }
        const certainty = compareCertainty(assertion, primaryEvidenceText || evidenceText)
        for (const mismatch of certainty) {
          addDiagnostic({
            collection,
            itemIndex,
            field: factFieldFor(collection, item),
            reasonCode: mismatch.reason_code,
            severity: "hard",
            observed: mismatch.observed,
            expected: mismatch.expected,
            sourceRefs: refs,
            message: `${collection}[${itemIndex}] ${mismatch.message}`,
          })
        }
      }
      if (semanticText && !evidenceSupportsCandidate(semanticText, evidenceText, item, collection)) {
        addDiagnostic({
          collection,
          itemIndex,
          field: factFieldFor(collection, item),
          reasonCode: "LEXICAL_MISMATCH",
          severity: "warning",
          observed: semanticText,
          expected: "semantically related evidence; wording may be paraphrased",
          sourceRefs: refs,
          message: `${collection}[${itemIndex}] wording differs from the evidence; typed anchors remain the hard check`,
        })
      }
      if (["entities", "concepts"].includes(collection)) {
        const evidenceNormalized = normalizeGroundingText(evidenceText)
        const matchedAliases = [...new Set(candidateAliasValues(item)
          .filter((alias) => normalizeGroundingText(alias).length >= 2)
          .filter((alias) => evidenceNormalized.includes(normalizeGroundingText(alias))))]
        if (matchedAliases.length > 1) {
          addDiagnostic({
            collection,
            itemIndex,
            field: "aliases",
            reasonCode: "ENTITY_ALIAS_AMBIGUITY",
            severity: "warning",
            observed: matchedAliases,
            expected: "one canonical alias or explicit review",
            sourceRefs: refs,
            message: `${collection}[${itemIndex}] has multiple aliases supported by the same evidence; review canonicalization`,
          })
        }
      }
    }
  }

  // Reuse is diagnostic only. Context references (for example one table
  // header shared by many rows) are deliberately excluded from this count.
  for (const { count, paths, ref } of refUses.values()) {
    if (count <= SOURCE_REF_REUSE_WARNING_THRESHOLD) continue
    addDiagnostic({
      collection: "sourceRefs",
      itemIndex: 0,
      field: null,
      reasonCode: "SOURCE_REF_REUSE",
      severity: "warning",
      observed: count,
      expected: `reuse is grouped by ${sourceRefContextGroup(ref)} and candidate type; no hard global limit`,
      sourceRefs: [ref],
      message: `A primary SourceRef is reused by ${count} candidates (${paths.join(", ")}); reuse is allowed but review the evidence granularity`,
    })
  }

  const allDiagnostics = [...hardErrors, ...warnings]
  const validationFingerprint = sha256(stableStringify({
    count: hardErrorCount,
    errors: hardErrors.map(({ path, field, reason_code, observed, expected, sourceRefs }) => ({ path, field, reason_code, observed, expected, sourceRefs })),
  })).slice(0, 32)
  const report = {
    quality_gate: "source-ref-grounding-v2",
    validation_error_count: hardErrorCount,
    validation_errors: hardErrors,
    validation_error_messages: hardErrors.map((diagnostic) => diagnostic.message),
    grounding_warnings: warnings,
    validation_diagnostics: allDiagnostics,
    validation_fingerprint: validationFingerprint,
    warning_count: warningCount,
    diagnostics_truncated: hardErrorCount > maxDiagnostics || warningCount > maxDiagnostics,
  }
  if (hardErrorCount > 0) {
    fail("INVALID_ANALYSIS", "Analysis grounding quality validation failed for typed facts or certainty.", {
      details: report,
    })
  }
  return report
}

function candidateSemanticText(item, collection = "claims") {
  return [...candidateAssertionTexts(item, collection), ...candidateAliasValues(item)].join(" ")
}

function factFieldFor(collection, item) {
  if (collection === "reviewItems") return "content"
  if (collection === "relations" && (item.content || item.text)) return item.content ? "content" : "text"
  if (item.content) return "content"
  if (item.text) return "text"
  if (collection === "relations" && (item.subject || item.object)) return "subject/object"
  return "assertion"
}

function evidenceSupportsCandidate(semanticText, evidenceText, item, collection) {
  const normalizedEvidence = normalizeGroundingText(evidenceText)
  const evidenceTerms = new Set(groundingTerms(evidenceText))
  // Schema relation names, titles, aliases, and page labels are metadata. They
  // may be normalized without being copied verbatim into source prose.
  for (const assertion of candidateAssertionTexts(item, collection)) {
    const normalizedAssertion = normalizeGroundingText(assertion)
    if (normalizedAssertion.length >= 3 && normalizedEvidence.includes(normalizedAssertion)) return true
    if (groundingTermsSupported(assertion, evidenceTerms)) return true
  }
  for (const label of candidateAliasValues(item)) {
    const normalizedLabel = normalizeGroundingText(label)
    if (normalizedLabel.length >= 2 && normalizedEvidence.includes(normalizedLabel)) return true
    const labelAnchors = parseFactAnchors(label)
    if (labelAnchors.some((anchor) => anchorCovered(anchor, parseFactAnchors(evidenceText)))) return true
  }
  const semanticTerms = groundingTerms(semanticText)
  if (semanticTerms.length === 0 || evidenceTerms.size === 0) return false
  const overlap = semanticTerms.filter((term) => evidenceTerms.has(term)).length
  return overlap >= 2 && overlap / semanticTerms.length >= 0.5
}

function candidateAssertionTexts(item, collection = "claims") {
  const values = []
  if (typeof item?.content === "string" && item.content.trim()) values.push(item.content)
  if (typeof item?.text === "string" && item.text.trim()) values.push(item.text)
  if (collection === "relations") {
    const relationTuple = [item.subject, item.object]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" ")
    if (relationTuple) values.push(relationTuple)
  }
  // Names, titles, local IDs, and internal relation predicates are metadata,
  // not factual assertion text. Entity aliases are handled as a semantic
  // warning/review path below rather than being treated as body assertions.
  return [...new Set(values)]
}

function candidateAliasValues(item) {
  const values = [item?.name, item?.title]
  if (Array.isArray(item?.aliases)) values.push(...item.aliases)
  if (Array.isArray(item?.properties?.aliases)) values.push(...item.properties.aliases)
  return values.filter((value) => typeof value === "string" && value.trim())
}

const UNIT_ALIASES = new Map([
  ["ms", "ms"], ["msec", "ms"], ["millisecond", "ms"], ["milliseconds", "ms"], ["毫秒", "ms"],
  ["s", "s"], ["sec", "s"], ["second", "s"], ["seconds", "s"], ["秒", "s"],
  ["min", "min"], ["minute", "min"], ["minutes", "min"], ["分钟", "min"],
  ["h", "h"], ["hr", "h"], ["hour", "h"], ["hours", "h"], ["小时", "h"],
  ["d", "d"], ["day", "d"], ["days", "d"], ["天", "d"],
  ["%", "%"], ["percent", "%"], ["percentage", "%"], ["百分比", "%"],
])

/**
 * Extract deterministic anchors from a factual assertion. This intentionally
 * does not attempt general NLP; unknown wording is handled as a warning.
 */
export function parseFactAnchors(value) {
  const text = typeof value === "string" ? value.normalize("NFKC") : ""
  if (!text) return []
  const anchors = []
  const occupied = []
  const add = (anchor, start, end) => {
    if (occupied.some((range) => start < range.end && end > range.start)) return
    occupied.push({ start, end })
    anchors.push({ ...anchor, raw: text.slice(start, end), _start: start })
  }
  const numberSource = "[-+]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?"
  const numberValue = (raw) => Number(String(raw).replace(/,/g, ""))
  const parseNumber = (raw) => numberValue(raw)

  // Dates must be occupied before range parsing, otherwise 2024-01-02 would
  // be mistaken for the numeric range 2024-01.
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?![\p{L}\p{N}_])/gu)) {
    add({ kind: "date", granularity: "day", year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, match.index, match.index + match[0].length)
  }
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])(\d{4})年(\d{1,2})月(\d{1,2})日?(?![\p{L}\p{N}_])/gu)) {
    add({ kind: "date", granularity: "day", year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, match.index, match.index + match[0].length)
  }

  for (const match of text.matchAll(new RegExp(`百分之\\s*(${numberSource})`, "gu"))) {
    add({ kind: "percentage", value: parseNumber(match[1]), unit: "%" }, match.index, match.index + match[0].length)
  }
  for (const match of text.matchAll(new RegExp(`(${numberSource})\\s*%`, "gu"))) {
    add({ kind: "percentage", value: parseNumber(match[1]), unit: "%" }, match.index, match.index + match[0].length)
  }
  for (const match of text.matchAll(new RegExp(`(${numberSource})\\s*/\\s*(${numberSource})`, "gu"))) {
    add({ kind: "ratio", numerator: parseNumber(match[1]), denominator: parseNumber(match[2]) }, match.index, match.index + match[0].length)
  }
  for (const match of text.matchAll(new RegExp(`(${numberSource})\\s*(?:-|–|—|~|至|到)\\s*(${numberSource})`, "gu"))) {
    add({ kind: "range", min: parseNumber(match[1]), max: parseNumber(match[2]) }, match.index, match.index + match[0].length)
  }
  const unitPattern = `(${numberSource})\\s*([A-Za-zµμ]+|毫秒|秒|分钟|小时|天|%)`
  for (const match of text.matchAll(new RegExp(unitPattern, "gu"))) {
    const unit = normalizeUnit(match[2])
    if (!unit) continue
    add({ kind: unit === "%" ? "percentage" : "measurement", value: parseNumber(match[1]), unit }, match.index, match.index + match[0].length)
  }
  // Years are distinct from complete dates. A leading separator that is part
  // of an identifier (A-2001) does not start a standalone year anchor.
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_-])(\d{4})(?![-/年\d])/gu)) {
    add({ kind: "date", granularity: "year", year: Number(match[1]) }, match.index, match.index + match[0].length)
  }
  // IDs are normalized for case and deterministic separators, but never
  // interpreted as ordinary numbers. This covers A2001/A-2001/A_2001 and
  // CamelCase identifiers containing a numeric suffix.
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*(?![\p{L}\p{N}_])/gu)) {
    add({ kind: "identifier", value: normalizeIdentifier(match[0]) }, match.index, match.index + match[0].length)
  }
  for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])(${numberSource})(?![\\p{L}\\p{N}_])`, "gu"))) {
    add({ kind: "number", value: parseNumber(match[1]) }, match.index, match.index + match[0].length)
  }
  return anchors
    .sort((left, right) => left._start - right._start)
    .map(({ _start: _ignored, ...anchor }) => anchor)
}

function normalizeUnit(value) {
  const normalized = String(value ?? "").normalize("NFKC").trim().toLowerCase()
  return UNIT_ALIASES.get(normalized) ?? null
}

function normalizeIdentifier(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[-_]/g, "")
}

function anchorCovered(anchor, evidenceAnchors) {
  return evidenceAnchors.some((candidate) => {
    if (anchor.kind === "date" && candidate.kind === "date") {
      if (anchor.granularity === "year") return anchor.year === candidate.year
      return candidate.granularity === "day"
        && anchor.year === candidate.year && anchor.month === candidate.month && anchor.day === candidate.day
    }
    if (anchor.kind === "identifier" && candidate.kind === "identifier") return anchor.value === candidate.value
    if (anchor.kind === "percentage" && candidate.kind === "percentage") return anchor.value === candidate.value && anchor.unit === candidate.unit
    if (anchor.kind === "ratio" && candidate.kind === "ratio") return anchor.numerator === candidate.numerator && anchor.denominator === candidate.denominator
    if (anchor.kind === "range" && candidate.kind === "range") return anchor.min === candidate.min && anchor.max === candidate.max
    if (anchor.kind === "measurement" && candidate.kind === "measurement") return anchor.value === candidate.value && anchor.unit === candidate.unit
    if (anchor.kind === "number" && candidate.kind === "number") return anchor.value === candidate.value
    if (anchor.kind === "number" && ["measurement", "percentage", "ratio", "range"].includes(candidate.kind)) {
      return candidate.kind === "measurement" && anchor.value === candidate.value && !candidate.unit
    }
    return false
  })
}

export function compareFactAnchors(assertion, evidence) {
  const assertionAnchors = parseFactAnchors(assertion)
  const evidenceAnchors = parseFactAnchors(evidence)
  const mismatches = []
  for (const anchor of assertionAnchors) {
    if (anchorCovered(anchor, evidenceAnchors)) continue
    const matchingKind = evidenceAnchors.find((candidate) => candidate.kind === anchor.kind)
    const message = anchor.kind === "date" && anchor.granularity === "day" && matchingKind?.granularity === "year"
      ? `完整日期 ${anchor.raw} 不能由仅有年份的证据 ${matchingKind.raw} 支持`
      : anchor.kind === "measurement" && matchingKind?.kind === "measurement"
        ? `单位或数值 ${anchor.raw} 与证据中的 ${matchingKind.raw} 不等价`
        : `事实锚点 ${anchor.raw} 未在所选证据中保持等价`
    mismatches.push({
      reason_code: anchor.kind === "identifier" ? "IDENTIFIER_MISMATCH"
        : anchor.kind === "date" ? "DATE_MISMATCH"
          : anchor.kind === "measurement" || anchor.kind === "percentage" ? "UNIT_OR_PERCENTAGE_MISMATCH"
            : "NUMERIC_ANCHOR_MISMATCH",
      observed: anchor.raw,
      expected: matchingKind?.raw ?? evidenceAnchors.map((item) => item.raw).slice(0, 20),
      message,
    })
  }
  // An explicit unit in evidence must not silently disappear from a numeric
  // assertion; this catches “50” rewritten from “50 ms”.
  for (const candidate of evidenceAnchors.filter((item) => item.kind === "measurement")) {
    const plain = assertionAnchors.find((item) => item.kind === "number" && item.value === candidate.value)
    const explicit = assertionAnchors.find((item) => item.kind === "measurement" && item.value === candidate.value)
    if (plain && !explicit) {
      mismatches.push({
        reason_code: "UNIT_MISSING",
        observed: plain.raw,
        expected: candidate.raw,
        message: `证据中的单位 ${candidate.unit} 不能在事实改写中被省略`,
      })
    }
  }
  return { assertionAnchors, evidenceAnchors, mismatches: uniqueAnchorMismatches(mismatches) }
}

function uniqueAnchorMismatches(mismatches) {
  const seen = new Set()
  return mismatches.filter((mismatch) => {
    const key = `${mismatch.reason_code}:${mismatch.observed}:${mismatch.expected}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function compareCertainty(assertion, evidence) {
  const candidate = certaintySignals(assertion)
  const source = certaintySignals(evidence)
  const mismatches = []
  if (source.hedged && !candidate.hedged && !candidate.question) {
    mismatches.push({
      reason_code: "CERTAINTY_STRENGTHENED",
      observed: assertion,
      expected: "preserve the source's uncertainty",
      message: "候选把证据中的可能性/不确定性改写成了确定陈述",
    })
  }
  if (source.negated !== candidate.negated && (source.negated || candidate.negated)) {
    mismatches.push({
      reason_code: "POLARITY_MISMATCH",
      observed: assertion,
      expected: evidence,
      message: "候选与证据的否定/肯定极性不一致",
    })
  }
  return mismatches
}

function certaintySignals(value) {
  const text = String(value ?? "").normalize("NFKC").toLowerCase()
  return {
    hedged: /(可能|或许|也许|预计|大约|约为|不确定|maybe|may|might|could|possibly|likely|approximately|approx\.?)/iu.test(text),
    // Keep negation detection conservative: a bare `非` also matches words
    // such as `非常`, which would incorrectly turn an ordinary Wiki sentence
    // into a polarity hard error. Prefer explicit negative compounds.
    negated: /(\b(?:not|no|never|disabled|inactive|failed|without)\b|没有|不能|禁用|失败|否定|不(?:是|能|会|可|存在|支持|同意|启用|活动|正确)|未(?:知|能|使用|启用|完成)|无(?:法|需|效))/iu.test(text),
    question: /[?？]|是否|whether|unknown|未知/iu.test(text),
  }
}

function sourceRefRole(ref) {
  return ref?.role === "context" || ref?.evidence_role === "context" ? "context" : "primary"
}

function sourceRefContextGroup(ref) {
  const locator = ref?.locator ?? {}
  if (locator.cellRange || locator.sheetName) return `table:${locator.sheetName ?? ""}:${locator.cellRange ?? ""}`
  if (Array.isArray(locator.headingPath) && locator.headingPath.length > 0) return `section:${locator.headingPath.join("/")}`
  return "chunk"
}

function sourceRefDiagnostic(ref) {
  return {
    sourceId: ref.sourceId,
    chunkId: ref.chunkId,
    role: sourceRefRole(ref),
  }
}

function boundDiagnosticValue(value) {
  if (Array.isArray(value)) return value.slice(0, 50).map(boundDiagnosticValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, boundDiagnosticValue(item)]))
  }
  return typeof value === "string" ? value.slice(0, 2_000) : value
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
    if (ref.role !== undefined && !["primary", "context"].includes(ref.role)) {
      fail("INVALID_SOURCE_REF", "SourceRef role must be primary or context.")
    }
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
      const { startOffset, endOffset, page, slide, headingPath, sheetName, cellRange } = ref.locator
      if (startOffset !== undefined && (!Number.isInteger(startOffset) || startOffset < 0)) fail("INVALID_SOURCE_REF", "locator.startOffset must be a non-negative integer.")
      if (endOffset !== undefined && (!Number.isInteger(endOffset) || endOffset < 0 || (startOffset !== undefined && endOffset < startOffset))) fail("INVALID_SOURCE_REF", "locator.endOffset is invalid.")
      if (page !== undefined && (!Number.isInteger(page) || page < 1)) fail("INVALID_SOURCE_REF", "locator.page must be a positive integer.")
      if (slide !== undefined && (!Number.isInteger(slide) || slide < 1)) fail("INVALID_SOURCE_REF", "locator.slide must be a positive integer.")
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
      if (slide !== undefined && Number.isInteger(chunk.slideNumber) && slide !== chunk.slideNumber) {
        fail("INVALID_SOURCE_REF", `locator.slide does not match chunk ${ref.chunkId}; copy an exact source_ref_templates value.`, {
          retryable: true,
          details: { expected_slide: chunk.slideNumber },
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
  for (const key of ["patchId", "path", "operation", "title", "pageKind", "rationale"]) {
    if (typeof patch[key] !== "string" || !patch[key].trim()) fail("INVALID_PAGE_PATCH", `Patch ${key} is required.`)
  }
  if (!new Set(["create", "replace", "merge"]).has(patch.operation)) fail("INVALID_PAGE_PATCH", `Unsupported page operation: ${patch.operation}`)
  if (patch.operation === "merge") {
    if (patch.content !== undefined) fail("INVALID_PAGE_PATCH", "Merge patches use sectionChanges, not a complete content body.")
    validateMergeSectionChanges(patch.sectionChanges, limits)
  } else {
    if (typeof patch.content !== "string" || !patch.content.trim()) fail("INVALID_PAGE_PATCH", `Patch content is required for ${patch.operation}.`)
    if (patch.sectionChanges !== undefined) fail("INVALID_PAGE_PATCH", `${patch.operation} patches use complete content, not sectionChanges.`)
  }
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
  for (const field of ["domainSchemaId", "domainSchemaVersion"]) {
    if (patch[field] !== undefined && (typeof patch[field] !== "string" || patch[field].length === 0 || patch[field].length > 200)) {
      fail("INVALID_PAGE_PATCH", `${field} must be a non-empty string no longer than 200 characters.`)
    }
  }
  if (patch.domainClassifications !== undefined) {
    if (!Array.isArray(patch.domainClassifications) || patch.domainClassifications.length > 100) {
      fail("INVALID_PAGE_PATCH", "domainClassifications must be an array with at most 100 items.")
    }
    for (const [index, classification] of patch.domainClassifications.entries()) {
      if (!classification || typeof classification !== "object" || Array.isArray(classification)) {
        fail("INVALID_PAGE_PATCH", `domainClassifications[${index}] must be an object.`)
      }
      if (!["entity", "concept"].includes(classification.kind)
        || typeof classification.typeId !== "string" || !classification.typeId.trim()
        || typeof classification.typeName !== "string" || !classification.typeName.trim()) {
        fail("INVALID_PAGE_PATCH", `domainClassifications[${index}] requires kind, typeId, and typeName.`)
      }
      for (const field of ["schemaId", "schemaVersion"]) {
        if (classification[field] !== undefined && (typeof classification[field] !== "string" || classification[field].length > 200)) {
          fail("INVALID_PAGE_PATCH", `domainClassifications[${index}].${field} is invalid.`)
        }
      }
      if (classification.schemaMode !== "progressive-directory-v2") {
        fail("INVALID_PAGE_PATCH", `domainClassifications[${index}].schemaMode must be progressive-directory-v2.`)
      }
      if (classification.status !== undefined && !["classified", "unresolved"].includes(classification.status)) {
        fail("INVALID_PAGE_PATCH", `domainClassifications[${index}].status is invalid.`)
      }
      if (classification.confidence !== undefined && (typeof classification.confidence !== "number" || classification.confidence < 0 || classification.confidence > 1)) {
        fail("INVALID_PAGE_PATCH", `domainClassifications[${index}].confidence is invalid.`)
      }
      for (const field of ["domain", "abe", "be"]) {
        if (classification[field] !== undefined && (!classification[field] || typeof classification[field] !== "object" || Array.isArray(classification[field]))) {
          fail("INVALID_PAGE_PATCH", `domainClassifications[${index}].${field} must be an object.`)
        }
      }
      if (classification.typeId.length > 200 || classification.typeName.length > 500) {
        fail("INVALID_PAGE_PATCH", `domainClassifications[${index}] exceeds its length limit.`)
      }
    }
  }
  validatePagePath(patch.path)
  const normalizedKind = normalizePageKind(patch.pageKind)
  const pathKind = pageKindForPath(patch.path)
  if (!normalizedKind || !pathKind || normalizedKind !== pathKind) fail("INVALID_PAGE_PATCH", "pageKind must match the Wiki collection in path.")
  if (typeof patch.content === "string" && patch.content.length > limits.maxPageChars) fail("INVALID_PAGE_PATCH", "Page content exceeds the workspace limit.")
  if (patch.expectedFileHash !== undefined && !/^[0-9a-f]{64}$/i.test(patch.expectedFileHash)) fail("INVALID_PAGE_PATCH", "expectedFileHash must be a SHA256 value.")
}

function validateMergeSectionChanges(value, limits) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    fail("INVALID_PAGE_PATCH", "Merge patch sectionChanges must contain 1 to 20 section upserts.")
  }
  const headings = new Set()
  let totalChars = 0
  for (const [index, change] of value.entries()) {
    if (!change || typeof change !== "object" || Array.isArray(change)) fail("INVALID_PAGE_PATCH", `sectionChanges[${index}] must be an object.`)
    for (const key of Object.keys(change)) {
      if (!["operation", "heading", "level", "content"].includes(key)) fail("INVALID_PAGE_PATCH", `sectionChanges[${index}] contains unsupported field: ${key}`)
    }
    if (change.operation !== "upsert_section") fail("INVALID_PAGE_PATCH", `sectionChanges[${index}].operation must be upsert_section.`)
    const heading = String(change.heading ?? "").normalize("NFKC").trim()
    const normalizedHeading = heading.replace(/\s+/g, " ").toLowerCase()
    const level = change.level === undefined ? 2 : Number(change.level)
    const content = String(change.content ?? "").replace(/\r\n?/g, "\n").trim()
    if (!heading || heading.length > 300 || /[\r\n]/.test(heading)) fail("INVALID_PAGE_PATCH", `Invalid sectionChanges[${index}].heading.`)
    if (CORE_OWNED_SECTION_HEADINGS.has(normalizedHeading)) fail("INVALID_PAGE_PATCH", `Section ${heading} is maintained by Core and cannot be edited directly.`)
    if (headings.has(normalizedHeading)) fail("INVALID_PAGE_PATCH", `Duplicate section change in one merge patch: ${heading}`)
    headings.add(normalizedHeading)
    if (!Number.isInteger(level) || level < 2 || level > 6) fail("INVALID_PAGE_PATCH", `Section level must be an integer from 2 to 6 for ${heading}.`)
    if (!content || content.length > limits.maxPageChars) fail("INVALID_PAGE_PATCH", `Section content for ${heading} must contain 1 to ${limits.maxPageChars} characters.`)
    totalChars += content.length
  }
  if (totalChars > limits.maxPageChars) fail("INVALID_PAGE_PATCH", "Merge patch section content exceeds the workspace page limit.")
}

// Domain classifications are derived from the server-side page requirements.
// A Writer may receive them as scaffolding for prose generation, but it cannot
// change the classification that Core persists. Tasks without a domain Schema
// retain legacy patch behavior for compatibility.
export function normalizePagePatchDomainClassifications(patch, requirements) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Array.isArray(requirements)) {
    return { patch, derived: false }
  }
  const hasDomainSchema = requirements.some((requirement) => typeof requirement?.domain_schema_id === "string" && requirement.domain_schema_id)
  if (!hasDomainSchema) return { patch, derived: false }
  const requirementById = new Map(requirements.map((requirement) => [requirement?.requirement_id, requirement]))
  const coveredIds = Array.isArray(patch.covers) ? patch.covers : []
  const classifications = []
  const seen = new Set()
  for (const requirementId of coveredIds) {
    const requirement = requirementById.get(requirementId)
    for (const classification of requirement?.domain_classifications ?? []) {
      const key = `${classification.kind}:${classification.type_id}`
      if (seen.has(key)) continue
      seen.add(key)
      classifications.push({
        kind: classification.kind,
        typeId: classification.type_id,
        typeName: classification.type_name,
        schemaId: classification.schema_id,
        schemaVersion: classification.schema_version,
        ...(classification.schema_mode ? { schemaMode: classification.schema_mode } : {}),
        ...(classification.status ? { status: classification.status } : {}),
        ...(classification.confidence !== undefined ? { confidence: classification.confidence } : {}),
        ...(classification.domain ? { domain: classification.domain } : {}),
        ...(classification.abe ? { abe: classification.abe } : {}),
        ...(classification.be ? { be: classification.be } : {}),
        ...(classification.resolved === false ? { resolved: false } : {}),
      })
    }
  }
  const schemaId = classifications.find((item) => item.schemaId)?.schemaId
  const schemaVersion = classifications.find((item) => item.schemaVersion)?.schemaVersion
  return {
    patch: {
      ...patch,
      domainClassifications: classifications,
      ...(schemaId ? { domainSchemaId: schemaId } : {}),
      ...(schemaVersion ? { domainSchemaVersion: schemaVersion } : {}),
    },
    derived: true,
  }
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
