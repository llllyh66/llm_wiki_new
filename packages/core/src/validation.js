import { lstat } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"
import { stableStringify } from "./utils.js"
import { AGENT_PAGE_ROOTS, normalizePageKind, pageKindForPath } from "./wiki-page.js"

const ANALYSIS_ARRAYS = ["sourceRefs", "entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems", "unresolvedQuestions"]
const GROUNDED_ANALYSIS_COLLECTIONS = new Set(["entities", "concepts", "claims", "relations", "contradictions", "candidatePages", "reviewItems"])
const MAX_ANALYSIS_VALIDATION_ERRORS = 50
const MAX_SOURCE_REF_REUSE = 8
const GROUNDING_QUALITY_COLLECTIONS = new Set(["claims", "relations", "contradictions", "reviewItems"])
const GENERIC_GROUNDING_TERMS = new Set(["content", "data", "document", "item", "内容", "数据", "文档", "指标", "体系", "关系", "概述", "包含", "包括"])
const GROUNDING_STOP_WORDS = new Set([
  "the", "is", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "this", "that", "these", "those", "be", "as", "by", "from", "it", "its",
  "的", "是", "了", "在", "有", "和", "与", "对", "从", "一个",
])
const NEGATION_TERMS = new Set(["not", "no", "never", "without", "cannot", "disabled", "prohibited", "禁止", "不能", "不得", "未", "无", "不"])
const STRONG_ANCHOR_UNITS = new Set([
  "usd", "eur", "cny", "rmb", "gbp", "jpy", "ms", "sec", "min", "hour", "hz", "khz", "mhz", "ghz",
  "kb", "mb", "gb", "tb", "bps", "kbps", "mbps", "gbps", "kg", "km", "cm", "mm", "kw",
  "%", "美元", "欧元", "人民币", "毫秒", "秒", "分钟", "小时", "千克", "公里", "米",
])
const PREDICATE_ALIAS_GROUPS = new Map([
  ["responsiblefor", ["responsible for", "is responsible for", "负责"]],
  ["dependson", ["depends on", "dependent on", "依赖"]],
  ["partof", ["part of", "belongs to", "属于"]],
  ["managedby", ["managed by", "管理"]],
])
const GROUNDING_QUALITY_GATE = "source-ref-grounding-v2"
const ALLOWED_PAGE_ROOTS = new Set(AGENT_PAGE_ROOTS)
const SYSTEM_PAGES = new Set(["wiki/index.md", "wiki/overview.md", "wiki/log.md"])
const ANALYSIS_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion", "taskId", "batchId", "sourceRefs", "sourceRefMode", "entities", "concepts",
  "claims", "relations", "contradictions", "candidatePages", "reviewItems", "batchSummary", "unresolvedQuestions",
])
const ANALYSIS_ARRAY_LIMITS = Object.freeze({ sourceRefs: 500, entities: 500, concepts: 500, claims: 1_000, relations: 1_000, contradictions: 500, candidatePages: 500, reviewItems: 500, unresolvedQuestions: 200 })
const PAGE_PATCH_FIELDS = new Set(["patchId", "path", "operation", "expectedFileHash", "title", "pageKind", "content", "summary", "domainSchemaId", "domainSchemaVersion", "domainClassifications", "tags", "related", "covers", "sourceRefs", "rationale"])

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
  const unresolved = normalizeUnresolvedQuestions(analysis.unresolvedQuestions)
  const normalized = { ...analysis, ...(unresolved.value ? { unresolvedQuestions: unresolved.value } : {}) }
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

export function validateGroundingQuality(analysis) {
  const errors = []
  const diagnostics = []
  const warnings = []
  const refUses = new Map()
  const candidateNames = analysisCandidateNames(analysis)
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
      const path = `${collection}[${itemIndex}]`
      const evidenceText = item.sourceRefs
        .filter(isSourceRefObject)
        .map((ref) => typeof ref.quote === "string" ? ref.quote.trim() : "")
        .filter(Boolean)
        .join("\n")
      if (!evidenceText) {
        const diagnostic = groundingDiagnostic(path, "MISSING_EVIDENCE_QUOTE", "sourceRefs", `${path} requires a non-empty SourceRef quote that supports its content`)
        diagnostics.push(diagnostic)
        errors.push(diagnostic.message)
        continue
      }
      const diagnostic = candidateGroundingDiagnostic(collection, path, item, evidenceText, candidateNames)
      if (diagnostic) {
        diagnostics.push(diagnostic)
        errors.push(diagnostic.message)
      }
    }
  }
  for (const { count, paths } of refUses.values()) {
    if (count > MAX_SOURCE_REF_REUSE) {
      warnings.push({
        reason_code: "HIGH_SOURCE_REF_REUSE",
        count,
        candidate_paths: paths,
        message: `one SourceRef is reused by ${count} grounded candidates (${paths.join(", ")}, ...); verify that the passage is specific enough for each candidate`,
      })
    }
  }
  if (errors.length > 0) {
    fail("INVALID_ANALYSIS", "Analysis grounding quality validation failed.", {
      details: {
        validation_errors: errors.slice(0, MAX_ANALYSIS_VALIDATION_ERRORS),
        validation_error_count: errors.length,
        grounding_diagnostics: diagnostics.slice(0, MAX_ANALYSIS_VALIDATION_ERRORS),
        grounding_warnings: warnings,
        quality_gate: GROUNDING_QUALITY_GATE,
      },
    })
  }
  return {
    quality_gate: GROUNDING_QUALITY_GATE,
    warning_count: warnings.length,
    warnings,
  }
}

function candidateGroundingDiagnostic(collection, path, item, evidenceText, candidateNames) {
  const supportType = item.supportType ?? item.support_type
  if (supportType === "inferred") {
    return groundingDiagnostic(
      path,
      "INFERRED_FACT_NOT_PUBLISHABLE",
      "supportType",
      `${path} is marked inferred and cannot be committed as a grounded fact; move it to reviewItems or unresolvedQuestions`,
    )
  }
  const assertion = candidateAssertionText(item)
  if (!assertion) return null

  const unsupportedAnchors = groundingAnchors(assertion).filter((anchor) => !groundingAnchors(evidenceText).includes(anchor))
  if (unsupportedAnchors.length > 0) {
    return groundingDiagnostic(
      path,
      "UNSUPPORTED_STRONG_ANCHOR",
      "content",
      `${path} introduces identifiers, numbers, dates, or units that do not occur in its SourceRef quote`,
      { unsupported_anchors: unsupportedAnchors },
    )
  }

  if (hasGroundingNegation(assertion) !== hasGroundingNegation(evidenceText)) {
    return groundingDiagnostic(
      path,
      "POLARITY_MISMATCH",
      "content",
      `${path} changes the positive or negative polarity of its SourceRef quote`,
    )
  }

  if (collection === "relations") {
    const endpointDiagnostic = relationEndpointDiagnostic(path, item, evidenceText, candidateNames)
    if (endpointDiagnostic) return endpointDiagnostic
    const directionDiagnostic = relationDirectionDiagnostic(path, item, assertion, candidateNames)
    if (directionDiagnostic) return directionDiagnostic
    const predicateDiagnostic = relationPredicateDiagnostic(path, item, evidenceText)
    if (predicateDiagnostic) return predicateDiagnostic
  }

  const support = groundingTextSupport(assertion, evidenceText)
  if (!support.supported) {
    return groundingDiagnostic(
      path,
      "INSUFFICIENT_LEXICAL_SUPPORT",
      typeof item.content === "string" ? "content" : typeof item.text === "string" ? "text" : "candidate",
      `${path} SourceRef quote does not lexically support the candidate content; preserve a directly supported statement and keep normalized structure in dedicated fields`,
      { matched_terms: support.matchedTerms, unsupported_terms: support.unsupportedTerms },
    )
  }
  return null
}

function relationEndpointDiagnostic(path, item, evidenceText, candidateNames) {
  const endpoints = relationEndpoints(item, candidateNames)
  for (const endpoint of endpoints) {
    // Stable local IDs may intentionally point to a candidate from another
    // batch. Validate the endpoint surface when it is available here and let
    // page planning perform cross-batch ID resolution later.
    if (endpoint.value && !groundingPhraseSupported(endpoint.value, evidenceText)) {
      return groundingDiagnostic(
        path,
        "UNSUPPORTED_RELATION_ENDPOINT",
        endpoint.field,
        `${path} ${endpoint.role} endpoint is not supported by its SourceRef quote`,
        { endpoint_role: endpoint.role, endpoint: endpoint.value },
      )
    }
  }
  return null
}

function relationEndpoints(item, candidateNames) {
  return [
    {
      field: "sourceEntityLocalId",
      role: "source",
      value: firstString(item.subject, item.source, item.from, item.sourceName, item.sourceEntityName)
        ?? candidateNames.get(item.sourceEntityLocalId),
      localId: item.sourceEntityLocalId,
    },
    {
      field: "targetEntityLocalId",
      role: "target",
      value: firstString(item.object, item.target, item.to, item.targetName, item.targetEntityName)
        ?? candidateNames.get(item.targetEntityLocalId),
      localId: item.targetEntityLocalId,
    },
  ]
}

function relationDirectionDiagnostic(path, item, assertion, candidateNames) {
  const [source, target] = relationEndpoints(item, candidateNames)
  if (!source.value || !target.value) return null
  const normalizedSource = normalizeGroundingText(source.value)
  const normalizedTarget = normalizeGroundingText(target.value)
  if (!normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) return null
  if (normalizedSource.includes(normalizedTarget) || normalizedTarget.includes(normalizedSource)) return null
  const normalizedAssertion = normalizeGroundingText(assertion)
  const sourceIndex = normalizedAssertion.indexOf(normalizedSource)
  const targetIndex = normalizedAssertion.indexOf(normalizedTarget)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex < targetIndex) return null
  return groundingDiagnostic(
    path,
    "RELATION_DIRECTION_MISMATCH",
    "sourceEntityLocalId",
    `${path} relation endpoints are reversed relative to the evidence-facing content; use the inverse predicate when the source statement is passive`,
    { source_endpoint: source.value, target_endpoint: target.value },
  )
}

function relationPredicateDiagnostic(path, item, evidenceText) {
  const predicate = firstString(item.predicate, item.relationType, item.relation_type)
  if (!predicate) return null
  if (groundingPredicateSupported(predicate, evidenceText)) return null
  return groundingDiagnostic(
    path,
    "UNSUPPORTED_RELATION_PREDICATE",
    "predicate",
    `${path} relation predicate ${JSON.stringify(predicate)} is not directly supported by its SourceRef quote`,
    { predicate },
  )
}

function groundingPredicateSupported(predicate, evidenceText) {
  const key = normalizePredicateKey(predicate)
  const normalizedEvidence = normalizeGroundingText(evidenceText)
  const aliases = PREDICATE_ALIAS_GROUPS.get(key) ?? []
  if (aliases.some((alias) => normalizedEvidence.includes(normalizeGroundingText(alias)))) return true
  const predicateTerms = groundingTerms(predicate)
  if (predicateTerms.length === 0) return false
  const evidenceTerms = new Set(groundingTerms(evidenceText))
  return predicateTerms.every((term) => evidenceTerms.has(term))
}

function groundingPhraseSupported(value, evidenceText) {
  const normalizedValue = normalizeGroundingText(value)
  const normalizedEvidence = normalizeGroundingText(evidenceText)
  if (normalizedValue && normalizedEvidence.includes(normalizedValue)) return true
  const terms = groundingTerms(value)
  const evidenceTerms = new Set(groundingTerms(evidenceText))
  return terms.length > 0 && terms.every((term) => evidenceTerms.has(term))
}

function groundingTextSupport(assertion, evidenceText) {
  const normalizedAssertion = normalizeGroundingText(assertion)
  const normalizedEvidence = normalizeGroundingText(evidenceText)
  if (normalizedAssertion.length >= 3 && normalizedEvidence.includes(normalizedAssertion)) {
    return { supported: true, matchedTerms: groundingTerms(assertion), unsupportedTerms: [] }
  }
  const assertionTerms = groundingTerms(assertion)
  const evidenceTerms = new Set(groundingTerms(evidenceText))
  const matchedTerms = assertionTerms.filter((term) => evidenceTerms.has(term))
  const unsupportedTerms = assertionTerms.filter((term) => !evidenceTerms.has(term))
  const supported = assertionTerms.length > 0
    && (assertionTerms.length === 1
      ? matchedTerms.length === 1
      : matchedTerms.length >= 2 && matchedTerms.length / assertionTerms.length >= 0.5)
  return { supported, matchedTerms, unsupportedTerms }
}

function candidateAssertionText(item) {
  return firstString(item.content, item.text, item.name, item.title)
}

function groundingTerms(value) {
  const prepared = splitGroundingIdentifiers(String(value ?? "")).normalize("NFKC").toLowerCase()
  const terms = []
  for (const match of prepared.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0]
    if (!GROUNDING_STOP_WORDS.has(token) && token.length > 1) terms.push(groundingLemma(token))
    if (/[\u3400-\u9fff]/u.test(token)) {
      const chars = Array.from(token)
      for (let index = 0; index < chars.length - 1; index += 1) {
        const bigram = `${chars[index]}${chars[index + 1]}`
        if (!GROUNDING_STOP_WORDS.has(bigram)) terms.push(bigram)
      }
    }
  }
  return [...new Set(terms.filter((term) => term && !GENERIC_GROUNDING_TERMS.has(term)))]
}

function groundingLemma(token) {
  if (!/^[a-z]+$/u.test(token) || token.length <= 3) return token
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`
  if (token.endsWith("ing") && token.length > 5) {
    const base = token.slice(0, -3).replace(/([a-z])\1$/u, "$1")
    return /(?:at|ag|iz)$/u.test(base) ? `${base}e` : base
  }
  if (token.endsWith("ed") && token.length > 4) {
    if (/(?:ated|ged|ized|eed)$/u.test(token)) return token.slice(0, -1)
    return token.slice(0, -2).replace(/([a-z])\1$/u, "$1")
  }
  if (/(?:ches|shes|xes|zes|ses|oes)$/u.test(token) && token.length > 4) return token.slice(0, -2)
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1)
  return token
}

function splitGroundingIdentifiers(value) {
  return value
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
}

function normalizePredicateKey(value) {
  return normalizeGroundingText(splitGroundingIdentifiers(value)).replace(/[^\p{L}\p{N}]+/gu, "")
}

function groundingAnchors(value) {
  const anchors = []
  const normalized = String(value ?? "").normalize("NFKC").toLowerCase()
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+(?:[._:/%-][\p{L}\p{N}%]+)*/gu)) {
    const token = match[0]
    if (/\d/u.test(token) || STRONG_ANCHOR_UNITS.has(token)) anchors.push(token)
  }
  return [...new Set(anchors)]
}

function hasGroundingNegation(value) {
  const normalized = normalizeGroundingText(value)
  if (/[不未无]/u.test(normalized) || /禁止|不能|不得/u.test(normalized)) return true
  return normalized.split(/[^\p{L}\p{N}]+/u).some((term) => NEGATION_TERMS.has(term))
}

function analysisCandidateNames(analysis) {
  const names = new Map()
  for (const collection of ["entities", "concepts"]) {
    for (const item of Array.isArray(analysis?.[collection]) ? analysis[collection] : []) {
      const localId = item?.localId ?? item?.local_id
      const name = firstString(item?.name, item?.title, item?.text)
      if (typeof localId === "string" && name) names.set(localId, name)
    }
  }
  return names
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim()
}

function groundingDiagnostic(path, reasonCode, field, message, extra = {}) {
  return { path, reason_code: reasonCode, field, message, ...extra }
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
  if (patch.content.length > limits.maxPageChars) fail("INVALID_PAGE_PATCH", "Page content exceeds the workspace limit.")
  if (patch.expectedFileHash !== undefined && !/^[0-9a-f]{64}$/i.test(patch.expectedFileHash)) fail("INVALID_PAGE_PATCH", "expectedFileHash must be a SHA256 value.")
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
