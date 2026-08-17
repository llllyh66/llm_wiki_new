import assert from "node:assert/strict"
import test from "node:test"
import { compareFactAnchors, parseFactAnchors, validateGroundingQuality } from "../src/validation.js"

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
  assert.equal(report.quality_gate, "source-ref-grounding-v2")
  assert.equal(report.validation_error_count, 0)
})

test("grounding hard-fails a polarity contradiction with structured diagnostics", () => {
  const error = groundingError(() => validateGroundingQuality(analysisWithClaims([
    { content: "The billing account is disabled.", sourceRefs: [sourceRef] },
  ])))
  assert.equal(error.details.quality_gate, "source-ref-grounding-v2")
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
