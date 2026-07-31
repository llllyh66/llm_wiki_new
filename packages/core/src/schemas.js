export const analysisSchema = Object.freeze({
  $id: "https://llm-wiki.local/schemas/analysis-envelope-v1.json",
  type: "object",
  required: [
    "schemaVersion", "taskId", "batchId", "sourceRefs", "entities", "concepts",
    "claims", "relations", "contradictions", "candidatePages", "reviewItems",
    "batchSummary", "unresolvedQuestions",
  ],
  properties: {
    schemaVersion: { const: 1 },
    taskId: { type: "string" },
    batchId: { type: "string" },
    sourceRefs: { type: "array", items: { $ref: "#/$defs/sourceRef" }, maxItems: 500 },
    entities: { type: "array", maxItems: 500 },
    concepts: { type: "array", maxItems: 500 },
    claims: { type: "array", maxItems: 1000 },
    relations: { type: "array", maxItems: 1000 },
    contradictions: { type: "array", maxItems: 500 },
    candidatePages: { type: "array", maxItems: 500 },
    reviewItems: { type: "array", maxItems: 500 },
    batchSummary: { type: "string", maxLength: 20000 },
    unresolvedQuestions: { type: "array", items: { type: "string", maxLength: 2000 }, maxItems: 200 },
  },
  additionalProperties: false,
  $defs: {
    sourceRef: {
      type: "object",
      required: ["sourceId", "chunkId"],
      properties: {
        sourceId: { type: "string" },
        chunkId: { type: "string" },
        quote: { type: "string", maxLength: 1000 },
        locator: { type: "object" },
      },
      additionalProperties: false,
    },
  },
})

export const pagePatchSchema = Object.freeze({
  $id: "https://llm-wiki.local/schemas/page-patch-v1.json",
  type: "object",
  required: ["patchId", "path", "operation", "title", "pageKind", "content", "sourceRefs", "rationale"],
  properties: {
    patchId: { type: "string", minLength: 1, maxLength: 200 },
    path: { type: "string", pattern: "^wiki/(sources|entities|concepts|topics|comparisons)/.+\\.md$" },
    operation: { enum: ["create", "replace", "merge"] },
    expectedFileHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    title: { type: "string", minLength: 1, maxLength: 500 },
    pageKind: { type: "string", minLength: 1, maxLength: 100 },
    content: { type: "string", minLength: 1 },
    sourceRefs: { type: "array", items: analysisSchema.$defs.sourceRef, minItems: 1, maxItems: 500 },
    rationale: { type: "string", minLength: 1, maxLength: 10000 },
  },
  additionalProperties: false,
})

export const toolSchemas = Object.freeze({ analysisSchema, pagePatchSchema })
