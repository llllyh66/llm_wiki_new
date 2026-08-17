import assert from "node:assert/strict"
import test from "node:test"
import { compareFactAnchors, parseFactAnchors, validateAnalysisShape, validateGroundingQuality } from "../src/validation.js"

const sourceRef = Object.freeze({
  sourceId: "source-grounding",
  chunkId: "chunk-grounding",
  quote: "The billing account is active.",
})

function analysisWithClaims(claims) {
  return {
    claims,
    relations: [],
    contradictions: [],
    reviewItems: [],
    entities: [],
    concepts: [],
    candidatePages: [],
  }
}

function groundingError(run) {
  try {
    run()
  } catch (error) {
    return error
  }
  assert.fail("Expected grounding validation to fail")
}

test("grounding accepts a candidate lexically supported by its evidence", () => {
  assert.doesNotThrow(() => validateGroundingQuality(analysisWithClaims([
    { content: "The billing account is active.", sourceRefs: [sourceRef] },
  ])))
})

test("grounding allows Wiki paraphrase and reports lexical mismatch as a warning", () => {
  const report = validateGroundingQuality(analysisWithClaims([
    { content: "The billing account is currently enabled.", sourceRefs: [sourceRef] },
  ]))
  assert.equal(report.quality_gate, "source-ref-grounding-v3")
  assert.equal(report.validation_error_count, 0)
})

test("grounding hard-fails a polarity contradiction with structured diagnostics", () => {
  const error = groundingError(() => validateGroundingQuality(analysisWithClaims([
    { content: "The billing account is disabled.", sourceRefs: [sourceRef] },
  ])))
  assert.equal(error.details.quality_gate, "source-ref-grounding-v3")
  assert.equal(error.details.validation_errors[0].reason_code, "POLARITY_MISMATCH")
  assert.equal(typeof error.details.validation_errors[0].path, "string")
  assert.equal(typeof error.details.validation_fingerprint, "string")
})

test("typed anchors accept deterministic formats and reject altered values", () => {
  assert.deepEqual(parseFactAnchors("A-2001 50% 50/50 50 ms 2024-01-02"), [
    { kind: "identifier", value: "a2001", raw: "A-2001" },
    { kind: "percentage", value: 50, unit: "%", raw: "50%" },
    { kind: "ratio", numerator: 50, denominator: 50, raw: "50/50" },
    { kind: "measurement", value: 50, unit: "ms", raw: "50 ms" },
    { kind: "date", granularity: "day", year: 2024, month: 1, day: 2, raw: "2024-01-02" },
  ])
  assert.equal(compareFactAnchors("timeout 50 ms", "timeout 50毫秒").mismatches.length, 0)
  assert.equal(compareFactAnchors("timeout 50%", "timeout 50").mismatches.length > 0, true)
  assert.equal(compareFactAnchors("date 2024-01-02", "date 2024").mismatches[0].reason_code, "DATE_MISMATCH")
  assert.deepEqual(
    ["A2001", "A-2001", "A_2001"].map((value) => parseFactAnchors(value)[0].value),
    ["a2001", "a2001", "a2001"],
  )
  assert.equal(compareFactAnchors("date 2024/1/2", "date 2024年1月2日").mismatches.length, 0)
  assert.equal(compareFactAnchors("timeout 50", "timeout 50 ms").mismatches.some((item) => item.reason_code === "UNIT_MISSING"), true)
})

test("primary SourceRef reuse is a warning and context reuse is ignored", () => {
  const report = validateGroundingQuality(analysisWithClaims(
    Array.from({ length: 9 }, (_, index) => ({
      content: "The billing account is active.",
      sourceRefs: [sourceRef],
    })),
  ))
  assert.equal(report.validation_error_count, 0)
  assert.equal(report.grounding_warnings.some((warning) => warning.reason_code === "SOURCE_REF_REUSE"), true)
})

test("a table header shared by more than eight rows does not hard-fail", () => {
  const header = {
    sourceId: "source-grounding",
    chunkId: "chunk-grounding",
    quote: "| Parameter | Value |",
    role: "context",
  }
  const claims = Array.from({ length: 12 }, (_, index) => ({
    content: `Parameter ${index} has value ${index}.`,
    sourceRefs: [{
      ...sourceRef,
      quote: `| parameter-${index} | ${index} |`,
      role: "primary",
    }, header],
  }))
  const report = validateGroundingQuality(analysisWithClaims(claims))
  assert.equal(report.validation_error_count, 0)
  assert.equal(report.grounding_warnings.some((warning) => warning.reason_code === "SOURCE_REF_REUSE"), false)
})

test("grounding scopes polarity to the matching table row", () => {
  const tableRef = {
    sourceId: "source-grounding",
    chunkId: "chunk-grounding",
    role: "primary",
    quote: [
      "| 5G切换至4G切换准备次数 | / | IF TRANS_TYPE = 73 AND HO_TYPE = 1 THEN 1 ELSE 0 END | DETAIL_CDR_N2HANDOVER |",
      "| 5G切换至4G成功次数 | / | IF TRANS_TYPE = 73 AND HO_TYPE = 1 AND E2E_HANDOVER_SUCCED_FLAG = 0 THEN 1 ELSE 0 END | DETAIL_CDR_N2HANDOVER |",
      "| 5G切换至4G失败次数 | / | IF TRANS_TYPE = 73 AND HO_TYPE = 1 AND E2E_HANDOVER_SUCCED_FLAG = 1 THEN 1 ELSE 0 END | DETAIL_CDR_N2HANDOVER |",
    ].join("\n"),
  }
  const report = validateGroundingQuality({
    ...analysisWithClaims([]),
    relations: [{
      localId: "rel-5g-to-4g-counter-source",
      content: "5G切换至4G切换准备次数的COUNTER公式基于DETAIL_CDR_N2HANDOVER表,条件为TRANS_TYPE=73 AND HO_TYPE=1",
      factKind: "relation",
      supportMode: "explicit_text",
      sourceRefs: [tableRef],
    }],
  })
  assert.equal(report.validation_error_count, 0)
  assert.equal(report.grounding_warnings.some((warning) => warning.reason_code === "RELATION_ENDPOINT_MISSING"), true)
  assert.equal(report.grounding_warnings[0].sourceRefs[0].quoteHash.length, 16)
})

test("structured facts validate deterministic fields against their evidence scope", () => {
  const tableRef = {
    sourceId: "source-grounding",
    chunkId: "chunk-grounding",
    role: "primary",
    quote: "| 5G切换至4G切换准备次数 | / | IF TRANS_TYPE = 73 AND HO_TYPE = 1 THEN 1 ELSE 0 END | DETAIL_CDR_N2HANDOVER |",
  }
  const valid = validateGroundingQuality(analysisWithClaims([{
    localId: "metric-preparation",
    factKind: "metric_definition",
    supportMode: "structured_entailment",
    metric: "5G切换至4G切换准备次数",
    formula: "IF TRANS_TYPE = 73 AND HO_TYPE = 1 THEN 1 ELSE 0 END",
    sourceTable: "DETAIL_CDR_N2HANDOVER",
    sourceRefs: [tableRef],
  }]))
  assert.equal(valid.validation_error_count, 0)

  const error = groundingError(() => validateGroundingQuality(analysisWithClaims([{
    localId: "metric-preparation",
    factKind: "metric_definition",
    supportMode: "structured_entailment",
    metric: "5G切换至4G切换准备次数",
    sourceTable: "DETAIL_CDR_WRONG_TABLE",
    sourceRefs: [tableRef],
  }])))
  assert.equal(error.details.validation_errors[0].reason_code, "STRUCTURAL_FIELD_MISMATCH")
})

test("relation endpoint IDs must resolve when an ID-based edge is declared", () => {
  const relationRef = { ...sourceRef, quote: "Beta depends on Alpha." }
  const error = groundingError(() => validateGroundingQuality({
    ...analysisWithClaims([]),
    entities: [{ localId: "beta", name: "Beta", sourceRefs: [relationRef] }],
    relations: [{
      localId: "beta-depends-alpha",
      content: "Beta depends on Alpha.",
      predicate: "dependsOn",
      sourceEntityLocalId: "beta",
      targetEntityLocalId: "missing-alpha",
      sourceRefs: [relationRef],
    }],
  }))
  assert.equal(error.details.validation_errors.some((item) => item.reason_code === "RELATION_ENDPOINT_UNRESOLVED"), true)

  const report = validateGroundingQuality({
    ...analysisWithClaims([]),
    entities: [{ localId: "beta", name: "Beta", sourceRefs: [relationRef] }],
    relations: [{
      localId: "beta-depends-alpha",
      content: "Beta depends on Alpha.",
      predicate: "dependsOn",
      sourceEntityLocalId: "beta",
      targetEntityLocalId: "alpha",
      sourceRefs: [relationRef],
    }],
  }, { knownCandidateLocalIds: ["alpha"] })
  assert.equal(report.validation_error_count, 0)
})

test("typed envelope requires derivation metadata and matching summary semantics", () => {
  const envelope = {
    schemaVersion: 1,
    taskId: "task-grounding",
    batchId: "batch-grounding",
    sourceRefs: [sourceRef],
    entities: [],
    concepts: [],
    claims: [{
      localId: "derived-claim",
      content: "The account is enabled.",
      factKind: "claim",
      supportMode: "derived",
      sourceRefs: [sourceRef],
    }],
    relations: [],
    contradictions: [],
    candidatePages: [],
    reviewItems: [],
    batchSummary: "Derived fixture.",
    unresolvedQuestions: [],
  }
  assert.throws(
    () => validateAnalysisShape(envelope, envelope.taskId, envelope.batchId),
    (error) => error.details.validation_errors.some((message) => message.includes("derivation is required")),
  )
  envelope.claims[0].derivation = "rule-based-normalization"
  assert.doesNotThrow(() => validateAnalysisShape(envelope, envelope.taskId, envelope.batchId))
})
