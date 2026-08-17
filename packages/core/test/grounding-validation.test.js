import assert from "node:assert/strict"
import test from "node:test"
import { validateGroundingQuality } from "../src/validation.js"

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

test("grounding v1 accepts a candidate lexically supported by its evidence", () => {
  assert.doesNotThrow(() => validateGroundingQuality(analysisWithClaims([
    { content: "The billing account is active.", sourceRefs: [sourceRef] },
  ])))
})

test("grounding v1 rejects candidate wording that its evidence does not support", () => {
  const error = groundingError(() => validateGroundingQuality(analysisWithClaims([
    { content: "The transfer service is disabled.", sourceRefs: [sourceRef] },
  ])))
  assert.equal(error.details.quality_gate, "source-ref-grounding-v1")
  assert.match(error.details.validation_errors[0], /lexically support/)
})

test("grounding v1 treats excessive SourceRef reuse as a validation error", () => {
  const error = groundingError(() => validateGroundingQuality(analysisWithClaims(
    Array.from({ length: 9 }, (_, index) => ({
      content: `The billing account is active (candidate ${index}).`,
      sourceRefs: [sourceRef],
    })),
  )))
  assert.equal(error.details.quality_gate, "source-ref-grounding-v1")
  assert.match(error.details.validation_errors[0], /maximum 8 uses/)
})
