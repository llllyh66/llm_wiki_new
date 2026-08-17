import assert from "node:assert/strict"
import test from "node:test"
import { LlmWikiError } from "../src/errors.js"
import { validateGroundingQuality } from "../src/validation.js"

const sourceRef = (quote) => ({
  sourceId: "source-grounding",
  chunkId: "chunk-grounding",
  quote,
})

const analysisWithRelation = (quote, relation, extra = {}) => ({
  entities: [
    { localId: "marketing-manager", name: "MarketingManager", sourceRefs: [sourceRef(quote)] },
    { localId: "marketing-campaign", name: "MarketingCampaign", sourceRefs: [sourceRef(quote)] },
  ],
  concepts: [],
  claims: [],
  relations: [{ ...relation, sourceRefs: [sourceRef(quote)] }],
  contradictions: [],
  candidatePages: [],
  reviewItems: [],
  ...extra,
})

function groundingError(run) {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof LlmWikiError)
    assert.equal(error.code, "INVALID_ANALYSIS")
    assert.equal(error.details.quality_gate, "source-ref-grounding-v2")
    return error
  }
  assert.fail("Expected grounding validation to fail")
}

test("grounding v2 accepts deterministic predicate and identifier normalization", () => {
  const result = validateGroundingQuality(analysisWithRelation(
    "The MarketingManager is responsible for MarketingCampaigns.",
    {
      localId: "manager-responsible-for-campaign",
      sourceEntityLocalId: "marketing-manager",
      predicate: "responsibleFor",
      targetEntityLocalId: "marketing-campaign",
      content: "The MarketingManager is responsible for MarketingCampaigns.",
      supportType: "normalized",
    },
  ))

  assert.equal(result.quality_gate, "source-ref-grounding-v2")
  assert.equal(result.warning_count, 0)

  assert.doesNotThrow(() => validateGroundingQuality(analysisWithRelation(
    "The MarketingManager managed MarketingCampaigns.",
    {
      sourceEntityLocalId: "marketing-manager",
      predicate: "manages",
      targetEntityLocalId: "marketing-campaign",
      content: "The MarketingManager managed MarketingCampaigns.",
      supportType: "normalized",
    },
  )))
})

test("grounding v2 does not let matching endpoints hide an unsupported predicate", () => {
  const error = groundingError(() => validateGroundingQuality(analysisWithRelation(
    "The MarketingManager manages MarketingCampaigns.",
    {
      localId: "manager-responsible-for-campaign",
      sourceEntityLocalId: "marketing-manager",
      predicate: "responsibleFor",
      targetEntityLocalId: "marketing-campaign",
      content: "The MarketingManager manages MarketingCampaigns.",
      supportType: "normalized",
    },
  )))

  assert.equal(error.details.grounding_diagnostics[0].reason_code, "UNSUPPORTED_RELATION_PREDICATE")
  assert.equal(error.details.grounding_diagnostics[0].field, "predicate")
})

test("grounding v2 rejects unsupported semantic expansion", () => {
  const error = groundingError(() => validateGroundingQuality(analysisWithRelation(
    "The MarketingManager manages MarketingCampaigns.",
    {
      localId: "manager-campaign-expanded",
      content: "MarketingManager is responsible for design, planning, execution and governance of MarketingCampaign.",
      supportType: "direct",
    },
  )))

  assert.equal(error.details.grounding_diagnostics[0].reason_code, "INSUFFICIENT_LEXICAL_SUPPORT")
  assert.ok(error.details.grounding_diagnostics[0].unsupported_terms.includes("plan"))
})

test("grounding v2 rejects changed identifiers and polarity", () => {
  const identifierError = groundingError(() => validateGroundingQuality({
    claims: [{ content: "Account B4002 pays 40 USD.", sourceRefs: [sourceRef("Account B4001 pays 40 USD.")] }],
  }))
  assert.equal(identifierError.details.grounding_diagnostics[0].reason_code, "UNSUPPORTED_STRONG_ANCHOR")
  assert.deepEqual(identifierError.details.grounding_diagnostics[0].unsupported_anchors, ["b4002"])

  const unitError = groundingError(() => validateGroundingQuality({
    claims: [{ content: "Account B4001 pays 40 EUR.", sourceRefs: [sourceRef("Account B4001 pays 40 USD.")] }],
  }))
  assert.equal(unitError.details.grounding_diagnostics[0].reason_code, "UNSUPPORTED_STRONG_ANCHOR")
  assert.deepEqual(unitError.details.grounding_diagnostics[0].unsupported_anchors, ["eur"])

  const polarityError = groundingError(() => validateGroundingQuality({
    claims: [{ content: "Account B4001 is active.", sourceRefs: [sourceRef("Account B4001 is not active.")] }],
  }))
  assert.equal(polarityError.details.grounding_diagnostics[0].reason_code, "POLARITY_MISMATCH")
})

test("grounding v2 compares polarity with the best matching evidence sentence", () => {
  assert.doesNotThrow(() => validateGroundingQuality({
    claims: [{
      content: "Account B4001 pays 40 USD.",
      sourceRefs: [sourceRef("The retired account is not active. Account B4001 pays 40 USD.")],
    }],
  }))

  const error = groundingError(() => validateGroundingQuality({
    claims: [{
      content: "Account B4001 is active.",
      sourceRefs: [sourceRef("The retired account is active. Account B4001 is not active.")],
    }],
  }))
  assert.equal(error.details.grounding_diagnostics[0].reason_code, "POLARITY_MISMATCH")
})

test("grounding v2 uses strong anchors to select the relevant polarity sentence", () => {
  assert.doesNotThrow(() => validateGroundingQuality({
    claims: [{
      content: "Account B4002 is active.",
      sourceRefs: [sourceRef("Account B4001 is not active. Account B4002 is active.")],
    }],
  }))

  const error = groundingError(() => validateGroundingQuality({
    claims: [{
      content: "Account B4001 is active.",
      sourceRefs: [sourceRef("Account B4001 is not active. Account B4002 is active.")],
    }],
  }))
  assert.equal(error.details.grounding_diagnostics[0].reason_code, "POLARITY_MISMATCH")
})

test("grounding v2 ignores unrelated Chinese negation in another evidence sentence", () => {
  assert.doesNotThrow(() => validateGroundingQuality({
    claims: [{
      content: "工作温度应保持在 40 摄氏度。",
      sourceRefs: [sourceRef("旧版接口不得使用。工作温度应保持在 40 摄氏度。")],
    }],
  }))
})

test("grounding v2 rejects reversed relation endpoints", () => {
  const error = groundingError(() => validateGroundingQuality(analysisWithRelation(
    "The MarketingManager manages MarketingCampaigns.",
    {
      sourceEntityLocalId: "marketing-campaign",
      predicate: "manages",
      targetEntityLocalId: "marketing-manager",
      content: "The MarketingManager manages MarketingCampaigns.",
    },
  )))

  assert.equal(error.details.grounding_diagnostics[0].reason_code, "RELATION_DIRECTION_MISMATCH")
})

test("grounding v2 reports excessive SourceRef reuse as a warning instead of rejecting", () => {
  const ref = sourceRef("Business Entity is the canonical business object.")
  const result = validateGroundingQuality({
    entities: Array.from({ length: 9 }, (_, index) => ({
      localId: `business-entity-${index}`,
      name: "Business Entity",
      sourceRefs: [ref],
    })),
  })

  assert.equal(result.warning_count, 1)
  assert.equal(result.warnings[0].reason_code, "HIGH_SOURCE_REF_REUSE")
})
