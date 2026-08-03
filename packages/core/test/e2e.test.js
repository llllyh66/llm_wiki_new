import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { LlmWikiCore, LlmWikiError } from "../src/index.js"

const domainSchemaPath = fileURLToPath(new URL("../../../llm-wiki.domain-schema.json", import.meta.url))

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-core-"))
  const workspace = path.join(root, "workspace")
  const incoming = path.join(root, "incoming")
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(workspace), mkdir(incoming)]))
  const source = path.join(incoming, "product.md")
  const content = `# Product Model

Business Entity is the canonical business object.

| Field | Meaning |
| --- | --- |
| id | Stable identifier |

## Aggregate

An Aggregate groups related Business Entities.
`
  await writeFile(source, content)
  const core = await LlmWikiCore.open(workspace)
  return { root, workspace, incoming, source, content, core }
}

function analysisFor(taskId, batch) {
  const chunk = batch.chunks[0]
  const sourceRef = {
    sourceId: chunk.sourceId,
    chunkId: chunk.chunkId,
    quote: "Business Entity is the canonical business object.",
    locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
  }
  return {
    sourceRef,
    analysis: {
      schemaVersion: 1,
      taskId,
      batchId: batch.batch_id,
      sourceRefs: [sourceRef],
      entities: [{ localId: "entity-business", name: "Business Entity", confidence: 0.98, sourceRefs: [sourceRef] }],
      concepts: [{ localId: "concept-aggregate", name: "Aggregate", confidence: 0.9, sourceRefs: [sourceRef] }],
      claims: [{ localId: "claim-1", text: "Business Entity is the canonical business object.", confidence: 0.95, sourceRefs: [sourceRef] }],
      relations: [],
      contradictions: [],
      candidatePages: [{ localId: "page-business", title: "Business Entity", pageKind: "concept", sourceRefs: [sourceRef] }],
      reviewItems: [],
      batchSummary: "Defines Business Entity and Aggregate.",
      unresolvedQuestions: [],
    },
  }
}

async function analyzeAll(core, imported) {
  let lastRef
  while (true) {
    const batch = await core.getBatch({ task_id: imported.task_id })
    if (batch.completed) break
    const { sourceRef, analysis } = analysisFor(imported.task_id, batch)
    lastRef = sourceRef
    const committed = await core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      analysis,
      idempotency_key: `analysis-${batch.batch_id}`,
    })
    assert.equal(committed.accepted, true)
    const replay = await core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      analysis,
      idempotency_key: `analysis-${batch.batch_id}`,
    })
    assert.equal(replay.idempotent_replay, true)
  }
  return lastRef
}

test("analysis normalizer resolves SourceRef indexes and rejects out-of-range indexes and malformed review items", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  const { sourceRef, analysis } = analysisFor(imported.task_id, batch)
  analysis.entities[0].sourceRefs = [3]

  await assert.rejects(
    () => f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      analysis,
      idempotency_key: "out-of-range-source-ref-index",
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "INVALID_ANALYSIS"
      && error.details.validation_errors.includes("entities[0].sourceRefs[0] index 3 is out of range for top-level sourceRefs length 1"),
  )

  analysis.entities[0].sourceRefs = [0]
  analysis.reviewItems = ["Missing formula"]
  await assert.rejects(
    () => f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      analysis,
      idempotency_key: "malformed-review-item",
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "INVALID_ANALYSIS"
      && error.details.validation_errors.includes("reviewItems[0] must be an object"),
  )

  analysis.reviewItems = [{ content: "Business Entity requires review.", sourceRefs: [0] }]
  const committed = await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    analysis,
    idempotency_key: "valid-indexed-source-refs",
  })
  assert.equal(committed.accepted, true)
  assert.equal(committed.normalized_source_ref_indexes, 2)
  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  assert.deepEqual(plan.analysis_summary.entities[0].sourceRefs, [sourceRef])
})

test("grounding quality gate rejects a title-only SourceRef reused for many unrelated claims", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  const chunk = batch.chunks[0]
  const titleRef = {
    sourceId: chunk.sourceId,
    chunkId: chunk.chunkId,
    quote: "Product Model",
    locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
  }
  const analysis = {
    schemaVersion: 1,
    taskId: imported.task_id,
    batchId: batch.batch_id,
    sourceRefs: [titleRef],
    entities: [],
    concepts: [],
    claims: Array.from({ length: 12 }, (_, index) => ({
      localId: `claim-metric-${index}`,
      name: `DNS metric ${index}`,
      content: `DNS query latency metric ${index} measures network response time.`,
      sourceRefs: [0],
    })),
    relations: [],
    contradictions: [],
    candidatePages: [],
    reviewItems: [],
    batchSummary: "Invalid title-only grounding fixture.",
    unresolvedQuestions: [],
  }

  await assert.rejects(
    () => f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      analysis,
      idempotency_key: "title-only-grounding",
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "INVALID_ANALYSIS"
      && error.details.quality_gate === "source-ref-grounding-v1"
      && error.details.validation_errors.some((message) => message.includes("does not lexically support"))
      && error.details.validation_errors.some((message) => message.includes("reused by 12 grounded candidates")),
  )
  assert.equal((await f.core.status({ task_id: imported.task_id })).status, "prepared")
})

test("domain schema is snapshotted, exposed to the Agent, and normalizes or drops typed candidates", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const domainSource = path.join(f.incoming, "domain-record.md")
  await writeFile(domainSource, "# 业务记录\n\n客户 C-001（张三）拥有产品 O-100（家庭宽带）。\n")
  const domainSchema = JSON.parse(await readFile(domainSchemaPath, "utf8"))
  domainSchema.policy.validationFailurePolicy = "drop-invalid"
  const imported = await f.core.importFiles({
    files: [{ path: domainSource }],
    options: { domain_schema: domainSchema },
  })
  assert.equal(imported.domain_schema.schema_id, "your-domain-schema")
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  assert.equal(batch.workspace_context.domain_schema.policy.validationFailurePolicy, "drop-invalid")
  assert.equal(batch.workspace_context.domain_schema.entityTypes.length, 3)
  const chunk = batch.chunks[0]
  const sourceRef = {
    sourceId: chunk.sourceId,
    chunkId: chunk.chunkId,
    quote: "客户 C-001（张三）拥有产品 O-100（家庭宽带）。",
    locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
  }
  const analysis = {
    schemaVersion: 1,
    taskId: imported.task_id,
    batchId: batch.batch_id,
    sourceRefs: [sourceRef],
    entities: [
      { local_id: "subject-1", name: "张三", entityType: "客户", properties: { "主体编号": "C-001", "主体名称": "张三" }, sourceRefs: [0] },
      { localId: "object-1", name: "家庭宽带", entityTypeId: "business_object", properties: { object_id: "O-100", object_name: "家庭宽带" }, sourceRefs: [0] },
      { localId: "event-1", name: "订购事件", entityTypeId: "business_event", properties: { event_id: "E-001" }, sourceRefs: [0] },
      { localId: "unknown-1", name: "未知", entityTypeId: "unknown_type", properties: {}, sourceRefs: [0] },
    ],
    concepts: [],
    claims: [],
    relations: [
      {
        local_id: "owns-1",
        name: "拥有",
        content: "客户 C-001（张三）拥有产品 O-100（家庭宽带）。",
        relationType: "业务主体拥有业务对象",
        sourceLocalId: "subject-1",
        targetLocalId: "object-1",
        properties: {},
        sourceRefs: [0],
      },
      {
        localId: "affects-1",
        name: "影响",
        content: "客户 C-001（张三）拥有产品 O-100（家庭宽带）。",
        relationTypeId: "event_affects_object",
        sourceEntityLocalId: "event-1",
        targetEntityLocalId: "object-1",
        properties: {},
        sourceRefs: [0],
      },
    ],
    contradictions: [],
    candidatePages: [],
    reviewItems: [],
    batchSummary: "客户拥有家庭宽带产品。",
    unresolvedQuestions: [],
  }
  await assert.rejects(
    () => f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      analysis,
      idempotency_key: "domain-schema-first-preflight-v1",
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "INVALID_DOMAIN_ANALYSIS"
      && error.details.schema_first_preflight === true
      && error.details.persisted === false,
  )
  assert.equal((await f.core.status({ task_id: imported.task_id })).completed_batches, 0)
  const committed = await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    analysis,
    accept_dropped_candidates: true,
    idempotency_key: "domain-schema-drop-invalid-v1",
  })
  assert.equal(committed.accepted, true)
  assert.equal(committed.domain_validation.dropped_entities, 2)
  assert.equal(committed.domain_validation.dropped_relations, 1)
  assert.equal(committed.domain_validation.validation_error_count >= 3, true)
  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  assert.equal(plan.domain_schema.schemaId, "your-domain-schema")
  assert.deepEqual(plan.analysis_summary.entities.map((item) => item.entityTypeId), ["business_subject", "business_object"])
  assert.deepEqual(plan.analysis_summary.entities[0].properties, { subject_id: "C-001", subject_name: "张三" })
  assert.equal(plan.analysis_summary.relations.length, 1)
  assert.equal(plan.analysis_summary.relations[0].relationTypeId, "subject_owns_object")
})

test("large domain schemas are summarized in batches and retrieved through bounded pages", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const entityTypes = Array.from({ length: 120 }, (_, typeIndex) => ({
    id: `entity_type_${typeIndex}`,
    name: `实体类型 ${typeIndex}`,
    description: `领域实体 ${typeIndex} ${"说明".repeat(80)}`,
    aliases: [`类型别名 ${typeIndex}`, ...(typeIndex === 42 ? ["Business Entity"] : [])],
    properties: Array.from({ length: 6 }, (_, propertyIndex) => ({
      id: `property_${propertyIndex}`,
      name: `属性 ${typeIndex}-${propertyIndex}`,
      description: `属性定义 ${typeIndex}-${propertyIndex} ${"约束".repeat(60)}`,
      valueType: "string",
      required: propertyIndex === 0,
      unique: propertyIndex === 0,
    })),
  }))
  const schema = {
    formatVersion: "1.0",
    schemaId: "large-domain-schema",
    schemaVersion: "1.0.0",
    name: "大型领域模型",
    description: "用于验证大型 Schema 的分页传输。",
    language: "zh-CN",
    policy: {
      extractionMode: "compatible",
      validationFailurePolicy: "drop-invalid",
      allowUnknownEntityTypes: false,
      allowUnknownRelationTypes: false,
      allowUnknownProperties: false,
    },
    entityTypes,
    relationTypes: [{
      id: "relates_to",
      name: "关联",
      description: "实体之间的关联。",
      aliases: [],
      sourceEntityTypeIds: ["entity_type_0"],
      targetEntityTypeIds: ["entity_type_1"],
      properties: [],
    }],
  }
  assert.equal(Buffer.byteLength(JSON.stringify(schema)) > 64 * 1024, true)
  const imported = await f.core.importFiles({ files: [{ path: f.source }], options: { domain_schema: schema } })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  assert.equal(batch.workspace_context.domain_schema.inline, false)
  assert.equal(batch.workspace_context.domain_schema.entityTypeCount, 120)
  assert.equal(batch.workspace_context.domain_schema.entityTypes, undefined)
  assert.deepEqual(batch.workspace_context.domain_schema_pagination, {
    required: true,
    cursor: 0,
    tool: "llm_wiki_get_domain_schema",
    recommended_mode: "search",
    recommended_max_matches: 12,
    fallback_modes: ["catalog", "types"],
    full_scan_required: false,
  })
  assert.equal(batch.workspace_context.domain_schema_auto_selection.ready, true)
  assert.equal(batch.workspace_context.domain_schema_auto_selection.selection.matched_entity_type_ids.includes("entity_type_42"), true)
  assert.equal(batch.workspace_context.domain_schema_auto_selection.items.some((item) => item.kind === "entity_type" && item.entity_type.id === "entity_type_42"), true)
  assert.equal(batch.workspace_context.domain_schema_auto_selection.payload_bytes <= 6 * 1024, true)
  assert.equal(batch.analysis_schema, undefined)
  assert.equal(batch.workspace_context.schema, undefined)
  assert.equal(batch.batch_limits.complete_response_bytes < batch.batch_limits.complete_response_target_bytes, true)
  assert.equal(Buffer.byteLength(JSON.stringify(batch, null, 2)) < 40 * 1024, true)
  assert.match(batch.workspace_context.domain_extraction_instructions, /no Schema tool call is needed/)
  assert.equal(batch.extraction_context_policy.retrieval_required, false)
  assert.equal(batch.extraction_context_policy.default, "skip_retrieve_context")
  assert.equal(batch.analysis_scaffold.schemaVersion, 1)
  assert.equal(batch.analysis_scaffold.taskId, imported.task_id)
  assert.equal(batch.analysis_scaffold.batchId, batch.batch_id)
  assert.deepEqual(batch.analysis_scaffold.reviewItems, [])

  const selected = await f.core.getDomainSchema({
    task_id: imported.task_id,
    mode: "search",
    queries: ["实体类型 42"],
    max_matches: 3,
    max_chars: 20_000,
  })
  assert.equal(selected.selection.mode, "search")
  assert.equal(selected.selection.full_schema_scan, false)
  assert.equal(selected.selection.matched_entity_type_ids.includes("entity_type_42"), true)
  assert.equal(selected.items.some((item) => item.kind === "entity_type" && item.entity_type.id === "entity_type_42"), true)
  assert.equal(selected.items.filter((item) => item.kind === "entity_type").length <= 3, true)

  const exact = await f.core.getDomainSchema({
    task_id: imported.task_id,
    mode: "types",
    entity_type_ids: ["entity_type_42"],
    relation_type_ids: ["relates_to"],
    max_chars: 20_000,
  })
  assert.deepEqual(exact.selection.matched_relation_type_ids, ["relates_to"])
  assert.equal(exact.items.some((item) => item.kind === "entity_property" && item.entity_type_id === "entity_type_42"), true)

  const catalog = await f.core.getDomainSchema({ task_id: imported.task_id, mode: "catalog", max_chars: 20_000 })
  assert.equal(catalog.selection.mode, "catalog")
  assert.equal(catalog.items.some((item) => item.kind === "entity_type_summary"), true)
  assert.equal(catalog.items.some((item) => item.kind === "entity_property"), false)

  const items = []
  let cursor = 0
  do {
    const page = await f.core.getDomainSchema({ task_id: imported.task_id, cursor, max_chars: 20_000 })
    assert.equal(Buffer.byteLength(JSON.stringify(page)) < 30_000, true)
    items.push(...page.items)
    cursor = page.pagination.next_cursor
  } while (cursor !== null)
  assert.equal(items.filter((item) => item.kind === "entity_type").length, 120)
  assert.equal(items.filter((item) => item.kind === "entity_property").length, 720)
  assert.equal(items.filter((item) => item.kind === "relation_type").length, 1)
})

test("domain schema allows an empty relationTypes array", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const schema = {
    formatVersion: "1.0",
    schemaId: "entity-only-schema",
    schemaVersion: "1.0.0",
    name: "仅实体领域模型",
    description: "只约束实体抽取，不定义关系类型。",
    language: "zh-CN",
    policy: {
      extractionMode: "strict",
      validationFailurePolicy: "drop-invalid",
      allowUnknownEntityTypes: false,
      allowUnknownRelationTypes: false,
      allowUnknownProperties: false,
    },
    entityTypes: [{
      id: "business_entity",
      name: "业务实体",
      description: "一个业务实体。",
      aliases: [],
      properties: [],
    }],
    relationTypes: [],
  }
  const imported = await f.core.importFiles({ files: [{ path: f.source }], options: { domain_schema: schema } })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  assert.deepEqual(batch.workspace_context.domain_schema.relationTypes, [])
  assert.equal(batch.workspace_context.domain_schema.entityTypes.length, 1)
  const chunk = batch.chunks[0]
  const sourceRef = {
    sourceId: chunk.sourceId,
    chunkId: chunk.chunkId,
    quote: "Business Entity is the canonical business object.",
    locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
  }
  const committed = await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    idempotency_key: "entity-only-domain-analysis",
    analysis: {
      schemaVersion: 1,
      taskId: imported.task_id,
      batchId: batch.batch_id,
      sourceRefs: [sourceRef],
      entities: [{ localId: "entity-1", name: "Business Entity", entityTypeId: "business_entity", properties: {}, sourceRefs: [0] }],
      concepts: [],
      claims: [],
      relations: [{
        localId: "relation-1",
        name: "self relation",
        content: "Business Entity is the canonical business object.",
        sourceRefs: [0],
      }],
      contradictions: [],
      candidatePages: [],
      reviewItems: [],
      batchSummary: "Entity-only extraction.",
      unresolvedQuestions: [],
    },
  })
  assert.equal(committed.accepted, true)
  assert.equal(committed.domain_validation.dropped_relations, 0)
  assert.equal(committed.domain_validation.relation_constraints_applied, false)
  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  assert.equal(plan.analysis_summary.relations.length, 1)
  assert.equal(plan.analysis_summary.relations[0].name, "self relation")
})

test("domain schema accepts bounded multi-megabyte input and rejects payloads over 5 MiB", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const makeSchema = (propertyCount, descriptionChars) => ({
    formatVersion: "1.0",
    schemaId: `sized-schema-${propertyCount}`,
    schemaVersion: "1.0.0",
    name: "容量边界模型",
    description: "验证领域 Schema 总大小限制。",
    language: "zh-CN",
    policy: {
      extractionMode: "strict",
      validationFailurePolicy: "drop-invalid",
      allowUnknownEntityTypes: false,
      allowUnknownRelationTypes: false,
      allowUnknownProperties: false,
    },
    entityTypes: [{
      id: "large_entity",
      name: "大型实体",
      description: "包含大量属性定义。",
      aliases: [],
      properties: Array.from({ length: propertyCount }, (_, index) => ({
        id: `property_${index}`,
        name: `属性 ${index}`,
        description: "x".repeat(descriptionChars),
        valueType: "string",
        required: false,
        unique: false,
      })),
    }],
    relationTypes: [{
      id: "self_relation",
      name: "自关联",
      description: "大型实体之间的关联。",
      aliases: [],
      sourceEntityTypeIds: ["large_entity"],
      targetEntityTypeIds: ["large_entity"],
      properties: [],
    }],
  })

  const acceptedSchema = makeSchema(450, 10_000)
  const acceptedBytes = Buffer.byteLength(JSON.stringify(acceptedSchema))
  assert.equal(acceptedBytes > 4 * 1024 * 1024, true)
  assert.equal(acceptedBytes < 5 * 1024 * 1024, true)
  const imported = await f.core.importFiles({ files: [{ path: f.source }], options: { domain_schema: acceptedSchema } })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  assert.equal(batch.workspace_context.domain_schema.inline, false)
  assert.equal(batch.workspace_context.domain_schema.totalBytes >= acceptedBytes, true)
  assert.equal(batch.workspace_context.domain_schema.totalBytes < 5 * 1024 * 1024, true)
  const chunk = batch.chunks[0]
  const sourceRef = {
    sourceId: chunk.sourceId,
    chunkId: chunk.chunkId,
    quote: "Business Entity is the canonical business object.",
    locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
  }
  await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    idempotency_key: "large-domain-schema-analysis-v1",
    analysis: {
      schemaVersion: 1,
      taskId: imported.task_id,
      batchId: batch.batch_id,
      sourceRefs: [sourceRef],
      entities: [{ localId: "large-entity-1", name: "Business Entity", entityTypeId: "large_entity", properties: {}, sourceRefs: [0] }],
      concepts: [], claims: [], relations: [], contradictions: [], candidatePages: [], reviewItems: [],
      batchSummary: "Large domain Schema page-plan regression.",
      unresolvedQuestions: [],
    },
  })
  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "wiki-writer-1", max_chars: 20_000 })
  assert.equal(plan.domain_schema.schemaId, acceptedSchema.schemaId)
  assert.equal(plan.domain_schema.sizeBytes >= acceptedBytes, true)
  assert.equal(plan.domain_schema.included, false)
  assert.equal(plan.domain_schema.requiredForPagePlanning, false)
  assert.equal(plan.domain_schema.entityTypes, undefined)
  assert.equal(plan.domain_schema_pagination, null)
  assert.equal(Buffer.byteLength(JSON.stringify(plan)) < 40_000, true)

  const oversizedSchema = makeSchema(550, 10_000)
  assert.equal(Buffer.byteLength(JSON.stringify(oversizedSchema)) > 5 * 1024 * 1024, true)
  await assert.rejects(
    () => f.core.importFiles({ files: [{ path: f.source }], options: { domain_schema: oversizedSchema } }),
    (error) => error instanceof LlmWikiError && error.code === "INVALID_DOMAIN_SCHEMA" && error.message.includes("5242880"),
  )
})

test("invalid domain schema is rejected before a task is created", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await assert.rejects(
    () => f.core.importFiles({
      files: [{ path: f.source }],
      options: { domain_schema: { formatVersion: "1.0", schemaId: "broken" } },
    }),
    (error) => error instanceof LlmWikiError && error.code === "INVALID_DOMAIN_SCHEMA",
  )
  assert.equal((await f.core.listTasks()).tasks.length, 0)
})

test("real embedding recall is cached and endpoint failures degrade without failing retrieval", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const semanticSource = path.join(f.incoming, "semantic.md")
  await writeFile(semanticSource, "# Transport\n\nAn automobile carries passengers between cities.\n")
  let requests = 0
  let endpointUnavailable = false
  let endpointMalformed = false
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (_url, options) => {
    requests += 1
    if (endpointUnavailable) throw new Error("endpoint unavailable")
    const payload = JSON.parse(options.body)
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input]
    return new Response(JSON.stringify({
      data: endpointMalformed ? [] : inputs.map((input, index) => ({
        index,
        embedding: /\b(car|automobile)\b/i.test(input) ? [1, 0, 0] : [0, 1, 0],
      })),
    }), { status: 200, headers: { "content-type": "application/json" } })
  }
  const endpoint = "http://embedding.test/v1/embeddings"
  const imported = await f.core.importFiles({ files: [{ path: semanticSource }] })
  const configPath = path.join(f.workspace, ".llm-wiki", "config.json")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.retrieval.embedding = { provider: "openai-compatible", model: "test-embedding", endpoint, batchSize: 8, maxDocuments: 100 }
  await writeFile(configPath, JSON.stringify(config))
  const batch = await f.core.getBatch({ task_id: imported.task_id })

  const first = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: batch.batch_id, queries: ["car"], channels: ["bm25", "embedding", "wiki"] })
  assert.equal(first.channel_status.embedding.mode, "embedding")
  assert.equal(first.hits.some((hit) => hit.kind === "source-chunk" && hit.snippet.includes("automobile")), true)
  assert.equal(first.corpus.by_kind["source-chunk"] > 0, true)
  const requestsAfterFirst = requests
  const second = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: batch.batch_id, queries: ["car"], channels: ["embedding"] })
  assert.equal(second.channel_status.embedding.cache_hits > 0, true)
  assert.equal(requests - requestsAfterFirst, 1)

  endpointMalformed = true
  const malformed = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: batch.batch_id, queries: ["car"], channels: ["embedding"] })
  assert.equal(malformed.channel_status.embedding.mode, "feature-hash-fallback")
  assert.equal(malformed.channel_status.embedding.reason, "EMBEDDING_INVALID_RESPONSE")

  endpointMalformed = false
  endpointUnavailable = true
  const degraded = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: batch.batch_id, queries: ["car"], channels: ["embedding"] })
  assert.equal(degraded.channel_status.embedding.mode, "feature-hash-fallback")
  assert.equal(degraded.channel_status.embedding.degraded, true)
  assert.equal(Array.isArray(degraded.hits), true)
})

test("Wiki title and bidirectional link neighbors participate in RRF", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const topics = path.join(f.workspace, "wiki", "topics")
  await mkdir(topics, { recursive: true })
  await writeFile(path.join(topics, "alpha.md"), "# AlphaTerm\n\nSee [[topics/hidden-neighbor]].\n")
  await writeFile(path.join(topics, "hidden-neighbor.md"), "# Hidden Neighbor\n\nLinked background knowledge.\n")
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  const retrieval = await f.core.retrieveContext({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    queries: ["AlphaTerm"],
    channels: ["bm25", "wiki"],
  })
  assert.equal(retrieval.fusion, "rrf")
  assert.deepEqual(retrieval.fusion_details.channels, ["bm25", "wiki"])
  assert.equal(retrieval.hits.some((hit) => hit.path === "wiki/topics/alpha.md"), true)
  assert.equal(retrieval.hits.some((hit) => hit.path === "wiki/topics/hidden-neighbor.md"), true)
})

test("Markdown attachment completes the model-free vertical slice", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))

  const imported = await f.core.importFiles({ files: [{ path: f.source, display_name: "Product Model.md" }] })
  assert.equal(imported.workspace_initialized, true)
  assert.equal(imported.status, "prepared")
  assert.equal(imported.accepted.length, 1)
  assert.equal(imported.rejected.length, 0)
  assert.match(imported.sources[0].managed_path, /^\.llm-wiki\/sources\/objects\/[0-9a-f]{64}\//)
  assert.equal(imported.sources[0].chunk_count > 0, true)
  await rm(f.source)

  const sourceRef = await analyzeAll(f.core, imported)
  const buildingRetrieval = await f.core.retrieveContext({ task_id: imported.task_id, queries: ["Business Entity"] })
  assert.equal(buildingRetrieval.retrieval_phase, "building")
  assert.deepEqual(buildingRetrieval.available_channels, ["bm25", "embedding"])
  const retrieval = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: "batch-0001", queries: ["Business Entity"], channels: ["bm25", "vector", "graph"] })
  assert.deepEqual(retrieval.available_channels, ["bm25", "vector", "graph"])
  assert.deepEqual(retrieval.pending_channels, [])

  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  assert.equal(plan.analysis_summary.claims.length, 1)
  assert.equal(plan.page_patch_schema.properties.path.type, "string")
  assert.deepEqual(plan.page_requirements.map((requirement) => requirement.title).sort(), ["Aggregate", "Business Entity"])
  const businessRequirement = plan.page_requirements.find((requirement) => requirement.title === "Business Entity")
  const aggregateRequirement = plan.page_requirements.find((requirement) => requirement.title === "Aggregate")
  const committed = await f.core.commitPages({
    task_id: imported.task_id,
    based_on_wiki_revision: plan.based_on_wiki_revision,
    idempotency_key: "pages-product-v1",
    patches: [{
      patchId: "business-entity-v1",
      path: "wiki/concepts/business-entity.md",
      operation: "create",
      title: "Business Entity",
      pageKind: "concept",
      content: "# Business Entity\n\nA canonical business object. See [[concepts/aggregate]].",
      summary: "The canonical business object.",
      tags: ["domain-model"],
      related: ["concepts/aggregate"],
      covers: [businessRequirement.requirement_id],
      sourceRefs: [sourceRef],
      rationale: "The source explicitly defines this concept.",
    }, {
      patchId: "aggregate-v1",
      path: "wiki/concepts/aggregate.md",
      operation: "create",
      title: "Aggregate",
      pageKind: "concept",
      content: "# Aggregate\n\nAn Aggregate groups related [[concepts/business-entity|Business Entities]].",
      summary: "Groups related Business Entities.",
      tags: ["domain-model"],
      related: ["concepts/business-entity"],
      covers: [aggregateRequirement.requirement_id],
      sourceRefs: [sourceRef],
      rationale: "The source explicitly defines Aggregate.",
    }],
  })
  assert.equal(committed.accepted, true)

  const result = await f.core.finalize({ task_id: imported.task_id })
  assert.equal(result.status, "completed")
  assert.equal(result.indexing.bm25, "completed")
  assert.equal(result.indexing.vector, "completed")
  assert.deepEqual(result.created_pages, ["wiki/concepts/business-entity.md", "wiki/concepts/aggregate.md"])
  assert.equal((await f.core.status({ task_id: imported.task_id })).status, "completed")
  assert.match(await readFile(path.join(f.workspace, "wiki", "index.md"), "utf8"), /Business Entity/)
  assert.match(await readFile(path.join(f.workspace, "wiki", "index.md"), "utf8"), /## Concepts/)
  assert.match(await readFile(path.join(f.workspace, "wiki", "overview.md"), "utf8"), new RegExp(imported.task_id))
  const businessPage = await readFile(path.join(f.workspace, "wiki", "concepts", "business-entity.md"), "utf8")
  const aggregatePage = await readFile(path.join(f.workspace, "wiki", "concepts", "aggregate.md"), "utf8")
  assert.match(businessPage, /related: \["concepts\/aggregate"/)
  assert.match(businessPage, /covers: \["page-/)
  assert.match(aggregatePage, /\[\[concepts\/business-entity\]\]/)
  assert.equal((await readFile(path.join(f.workspace, imported.sources[0].managed_path), "utf8")).includes("Product Model"), true)
  const completedRetrieval = await f.core.retrieveContext({ task_id: imported.task_id, queries: ["Business Entity"] })
  assert.equal(completedRetrieval.retrieval_phase, "knowledge-base-complete")
  assert.deepEqual(completedRetrieval.available_channels, ["bm25", "embedding", "wiki"])
  const again = await f.core.finalize({ task_id: imported.task_id })
  assert.deepEqual(again, result)
})

test("parallel workers lease distinct batches and concurrent commits preserve every result", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const files = []
  for (let index = 0; index < 8; index += 1) {
    const file = path.join(f.incoming, `parallel-${index}.md`)
    await writeFile(file, `# Parallel ${index}\n\n${"Business Entity is the canonical business object. Context. ".repeat(60)}\n`)
    files.push({ path: file })
  }
  const imported = await f.core.importFiles({ files, options: { max_batch_chars: 1_000 } })
  assert.equal(imported.batch_count > 1, true)
  assert.equal(imported.parallel_extraction.recommended_workers, Math.min(4, imported.batch_count))
  assert.equal(imported.parallel_extraction.worker_batch_quantum, Math.min(3, Math.ceil(imported.batch_count / imported.parallel_extraction.recommended_workers)))
  assert.equal(imported.parallel_extraction.checkpoint_each_batch, true)
  const workerCount = imported.batch_count
  const leased = await Promise.all(Array.from({ length: workerCount }, (_, index) => (
    f.core.getBatch({ task_id: imported.task_id, worker_id: `worker-${index}` })
  )))
  assert.equal(new Set(leased.map((batch) => batch.batch_id)).size, workerCount)
  const waiting = await f.core.getBatch({ task_id: imported.task_id, worker_id: "worker-overflow" })
  assert.equal(waiting.waiting, true)
  assert.equal(waiting.completed, false)
  const extractingStatus = await f.core.status({ task_id: imported.task_id })
  assert.equal(extractingStatus.parallel_extraction.recommended_workers, Math.min(4, imported.batch_count))
  assert.equal(extractingStatus.parallel_extraction.worker_batch_quantum, imported.parallel_extraction.worker_batch_quantum)
  assert.equal(extractingStatus.parallel_extraction.checkpoint_each_batch, true)

  await Promise.all(leased.map((batch, index) => {
    const chunk = batch.chunks.find((item) => item.text.includes("Business Entity is the canonical business object.")) ?? batch.chunks[0]
    const sourceRef = {
      sourceId: chunk.sourceId,
      chunkId: chunk.chunkId,
      quote: "Business Entity is the canonical business object.",
      locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
    }
    return f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      worker_id: batch.worker_id,
      idempotency_key: `parallel-analysis-${index}`,
      analysis: {
        schemaVersion: 1,
        taskId: imported.task_id,
        batchId: batch.batch_id,
        sourceRefs: [sourceRef],
        entities: [{ localId: `entity-${index}`, name: "Business Entity", sourceRefs: [0] }],
        concepts: [], claims: [], relations: [], contradictions: [], candidatePages: [], reviewItems: [],
        batchSummary: `Parallel batch ${index}.`,
        unresolvedQuestions: [],
      },
    })
  }))
  const status = await f.core.status({ task_id: imported.task_id })
  assert.equal(status.completed_batches, workerCount)
  assert.equal(status.leased_batches, 0)
  assert.equal(status.leased_batches_semantics, "persisted-reservations-not-live-agents")
  assert.equal(status.worker_recovery.resumable, true)
  assert.equal(status.worker_recovery.strategy, "restart-same-worker-id")
  assert.equal(status.worker_recovery.process_liveness_known, false)
  assert.equal(status.worker_recovery.leases_are_live_agents, false)
  assert.equal(status.status, "planning")
})

test("a worker invocation can resume its leased batch by stable worker ID after a turn boundary", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const leased = await f.core.getBatch({ task_id: imported.task_id, worker_id: "extractor-resume-1" })
  const status = await f.core.status({ task_id: imported.task_id })
  assert.equal(status.worker_recovery.leases_are_live_agents, false)
  assert.deepEqual(status.worker_recovery.leases.map(({ worker_id, batch_id }) => ({ worker_id, batch_id })), [{
    worker_id: "extractor-resume-1",
    batch_id: leased.batch_id,
  }])
  const resumed = await f.core.getBatch({ task_id: imported.task_id, worker_id: "extractor-resume-1" })
  assert.equal(resumed.batch_id, leased.batch_id)
  assert.deepEqual(resumed.chunks, leased.chunks)
})

test("micro-batch Wiki projection uses one writer, hides provisional pages, and requires final reconciliation", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const files = []
  for (let index = 0; index < 6; index += 1) {
    const file = path.join(f.incoming, `projection-${index}.md`)
    await writeFile(file, `# Projection ${index}\n\nBusiness Entity is the canonical business object. ${"Context ".repeat(105)}\n`)
    files.push({ path: file })
  }
  const imported = await f.core.importFiles({ files, options: { max_batch_chars: 1_000 } })
  assert.equal(imported.batch_count, 6)
  assert.equal(imported.wiki_projection.batch_threshold, 4)
  const sourceRefs = []
  const analyzeNext = async (index) => {
    const batch = await f.core.getBatch({ task_id: imported.task_id, worker_id: `projector-extractor-${index}` })
    const chunk = batch.chunks[0]
    const sourceRef = {
      sourceId: chunk.sourceId,
      chunkId: chunk.chunkId,
      quote: "Business Entity is the canonical business object.",
      locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
    }
    sourceRefs.push(sourceRef)
    const committed = await f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      worker_id: batch.worker_id,
      idempotency_key: `projection-analysis-${index}`,
      analysis: {
        schemaVersion: 1,
        taskId: imported.task_id,
        batchId: batch.batch_id,
        sourceRefs: [sourceRef],
        entities: [{ localId: `projection-entity-${index}`, name: "Business Entity", sourceRefs: [0] }],
        concepts: [], claims: [], relations: [], contradictions: [],
        candidatePages: [{ localId: `projection-page-${index}`, title: "Projected Entity", sourceRefs: [0] }],
        reviewItems: [],
        batchSummary: `Projection batch ${index}.`,
        unresolvedQuestions: [],
      },
    })
    return committed
  }

  await analyzeNext(0)
  assert.equal((await f.core.status({ task_id: imported.task_id })).wiki_projection.ready, false)
  const taskPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "task.json")
  const persistedTask = JSON.parse(await readFile(taskPath, "utf8"))
  persistedTask.batchCompletedAt[persistedTask.completedBatchIds[0]] = new Date(Date.now() - 31_000).toISOString()
  await writeFile(taskPath, JSON.stringify(persistedTask))
  const debounceReady = await f.core.status({ task_id: imported.task_id })
  assert.equal(debounceReady.wiki_projection.ready, true)
  assert.equal(debounceReady.wiki_projection.mode, "incremental")
  let projectionSignal
  for (let index = 1; index < 4; index += 1) projectionSignal = await analyzeNext(index)
  const ready = await f.core.status({ task_id: imported.task_id })
  assert.equal(ready.status, "extracting")
  assert.equal(ready.wiki_projection.ready, true)
  assert.equal(ready.wiki_projection.mode, "incremental")
  assert.equal(ready.next_action.tool, "llm_wiki_get_page_plan_context")
  assert.equal(ready.next_action.arguments.writer_id, "wiki-writer-1")
  assert.equal(projectionSignal.next_action.tool, "llm_wiki_get_page_plan_context")
  assert.equal(projectionSignal.worker_next_action.tool, "llm_wiki_get_batch")

  const incrementalPlan = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "wiki-writer-1" })
  assert.equal(incrementalPlan.waiting, undefined)
  assert.equal(incrementalPlan.projection.mode, "incremental")
  assert.equal(incrementalPlan.projection.batch_ids.length, 4)
  const competingWriter = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "wiki-writer-2" })
  assert.equal(competingWriter.waiting, true)
  assert.equal(competingWriter.projection.writer_busy, true)

  const provisional = await f.core.commitPages({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: incrementalPlan.projection.projection_id,
    based_on_wiki_revision: incrementalPlan.based_on_wiki_revision,
    idempotency_key: "incremental-projection-pages-v1",
    projection_complete: false,
    patches: [{
      patchId: "projected-entity-provisional-v1",
      path: "wiki/topics/projected-entity.md",
      operation: "create",
      title: "Projected Entity",
      pageKind: "topic",
      content: "# Projected Entity\n\nProvisionalOnlyMarker",
      covers: incrementalPlan.page_requirements.map((requirement) => requirement.requirement_id),
      sourceRefs: [sourceRefs[0]],
      rationale: "Early micro-batch projection.",
    }],
  })
  assert.equal(provisional.provisional, true)
  assert.equal(provisional.projection_complete, false)
  assert.deepEqual(provisional.provisional_pages, ["wiki/topics/projected-entity.md"])
  assert.equal(provisional.wiki_projection.in_progress, true)
  const hidden = await f.core.retrieveContext({ task_id: imported.task_id, queries: ["ProvisionalOnlyMarker"] })
  assert.equal(hidden.hits.some((hit) => hit.path === "wiki/topics/projected-entity.md"), false)
  const acknowledged = await f.core.commitPages({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: incrementalPlan.projection.projection_id,
    based_on_wiki_revision: provisional.wiki_revision,
    idempotency_key: "incremental-projection-ack-v1",
    patches: [],
  })
  assert.equal(acknowledged.projection_complete, true)
  assert.equal(acknowledged.wiki_projection.in_progress, false)

  await analyzeNext(4)
  await analyzeNext(5)
  const finalReady = await f.core.status({ task_id: imported.task_id })
  assert.equal(finalReady.status, "planning")
  assert.equal(finalReady.wiki_projection.ready, true)
  assert.equal(finalReady.wiki_projection.mode, "final")
  await assert.rejects(
    () => f.core.finalize({ task_id: imported.task_id }),
    (error) => error instanceof LlmWikiError && error.code === "FINAL_PROJECTION_REQUIRED",
  )

  const finalPlan = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "wiki-writer-1" })
  assert.equal(finalPlan.projection.mode, "final")
  assert.equal(finalPlan.projection.batch_ids.length, 6)
  const existing = finalPlan.existing_pages.find((page) => page.path === "wiki/topics/projected-entity.md")
  assert.equal(existing.provisional, true)
  const stable = await f.core.commitPages({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: finalPlan.projection.projection_id,
    based_on_wiki_revision: finalPlan.based_on_wiki_revision,
    idempotency_key: "final-projection-pages-v1",
    patches: [{
      patchId: "projected-entity-final-v1",
      path: "wiki/topics/projected-entity.md",
      operation: "replace",
      expectedFileHash: existing.file_hash,
      title: "Projected Entity",
      pageKind: "topic",
      content: "# Projected Entity\n\nStableFinalMarker",
      sourceRefs: [sourceRefs[0]],
      rationale: "Final full reconciliation.",
    }],
  })
  assert.equal(stable.provisional, false)
  assert.deepEqual(stable.provisional_pages, [])
  assert.equal(stable.wiki_projection.final_completed, true)
  const finalized = await f.core.finalize({ task_id: imported.task_id })
  assert.deepEqual(finalized.created_pages, ["wiki/topics/projected-entity.md"])
  assert.deepEqual(finalized.updated_pages, [])
  const completed = await f.core.retrieveContext({ task_id: imported.task_id, queries: ["StableFinalMarker"] })
  assert.equal(completed.retrieval_phase, "knowledge-base-complete")
  assert.deepEqual(completed.available_channels, ["bm25", "embedding", "wiki"])
  assert.equal(completed.hits.some((hit) => hit.path === "wiki/topics/projected-entity.md"), true)
})

test("duplicate content is reused and task recovery and abort stay workspace-scoped", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const first = await f.core.importFiles({ files: [{ path: f.source }] })
  const duplicatePath = path.join(f.incoming, "renamed.md")
  await writeFile(duplicatePath, f.content)
  const second = await f.core.importFiles({ files: [{ path: duplicatePath }] })
  assert.equal(second.accepted.length, 0)
  assert.equal(second.duplicates.length, 1)
  assert.equal(second.duplicates[0].duplicate_of, first.sources[0].source_id)
  const listed = await f.core.listTasks({ status: ["prepared"] })
  assert.equal(listed.tasks.length, 2)
  const aborted = await f.core.abort({ task_id: second.task_id, reason: "test cancellation" })
  assert.equal(aborted.status, "cancelled")
  assert.equal((await f.core.status({ task_id: second.task_id })).status, "cancelled")
})

test("get_batch repairs an 81K single-line legacy batch in place and preserves its worker lease", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batchesPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "batches.json")
  const taskPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "task.json")
  const leased = await f.core.getBatch({ task_id: imported.task_id, worker_id: "extractor-2" })
  const batches = JSON.parse(await readFile(batchesPath, "utf8"))
  const originalBatchId = batches[0].batchId
  const originalChunk = batches[0].chunks[0]
  assert.equal(leased.batch_id, originalBatchId)
  const oversizedText = "大".repeat(81_073)
  batches[0] = {
    ...batches[0],
    chunks: [{ ...originalChunk, text: oversizedText, structuredData: [{ rows: [["metric", oversizedText]] }] }],
    charCount: oversizedText.length,
  }
  await writeFile(batchesPath, JSON.stringify(batches))
  const task = JSON.parse(await readFile(taskPath, "utf8"))
  task.options.maxChunkChars = 100_000
  task.options.maxBatchChars = 100_000
  await writeFile(taskPath, JSON.stringify(task))

  const repaired = await f.core.getBatch({ task_id: imported.task_id, worker_id: "extractor-2", batch_id: originalBatchId, max_chars: 6_000 })
  assert.equal(repaired.batch_id, originalBatchId)
  assert.equal(repaired.batch_limits.complete, true)
  assert.equal(repaired.chunks.every((chunk) => chunk.text.length <= 3_000), true)
  assert.equal(repaired.batch_limits.char_count <= 6_000, true)
  assert.equal(repaired.batch_limits.payload_bytes <= 24 * 1024, true)
  assert.equal(repaired.batch_limits.agent_payload_ceiling_bytes, 24 * 1024)
  assert.equal(repaired.batch_limits.safely_repartitioned, true)
  assert.equal(Buffer.byteLength(JSON.stringify(repaired, null, 2)) < 40 * 1024, true)
  assert.equal(Math.max(...JSON.stringify(repaired, null, 2).split("\n").map((line) => line.length)) <= 4_000, true)
  assert.equal(repaired.chunks.every((chunk) => chunk.structuredData?.every((table) => table.compacted === true)), true)
  const persisted = JSON.parse(await readFile(batchesPath, "utf8"))
  assert.equal(persisted.length > 1, true)
  assert.equal(persisted[0].batchId, originalBatchId)
  const status = await f.core.status({ task_id: imported.task_id })
  assert.deepEqual(status.worker_recovery.leases.map(({ worker_id, batch_id }) => ({ worker_id, batch_id })), [{ worker_id: "extractor-2", batch_id: originalBatchId }])
})

test("page-plan pagination is revision-stable and oversized page commits are rejected", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const sourceRef = await analyzeAll(f.core, imported)
  const concepts = path.join(f.workspace, "wiki", "concepts")
  await import("node:fs/promises").then(({ mkdir }) => mkdir(concepts, { recursive: true }))
  for (let index = 0; index < 5; index += 1) {
    await writeFile(path.join(concepts, `existing-${index}.md`), `# Existing ${index}\n\n${"x".repeat(30_000)}\n`)
  }

  let cursor = 0
  let revision
  const existingPaths = []
  do {
    const page = await f.core.getPagePlanContext({ task_id: imported.task_id, cursor, max_chars: 20_000 })
    revision ??= page.based_on_wiki_revision
    assert.equal(page.based_on_wiki_revision, revision)
    assert.equal(page.pagination.returned_items > 0, true)
    existingPaths.push(...page.existing_pages.map((entry) => entry.path))
    cursor = page.next_cursor
  } while (cursor !== null)
  assert.equal(existingPaths.length, 5)
  assert.equal(new Set(existingPaths).size, 5)

  const oversizedPatches = Array.from({ length: 11 }, (_, index) => ({
    patchId: `oversized-${index}`,
    path: `wiki/topics/oversized-${index}.md`,
    operation: "create",
    title: `Oversized ${index}`,
    pageKind: "topic",
    content: `# Oversized ${index}\n\n${"y".repeat(199_800)}`,
    sourceRefs: [sourceRef],
    rationale: "Exercise the aggregate commit limit.",
  }))
  await assert.rejects(
    f.core.commitPages({
      task_id: imported.task_id,
      based_on_wiki_revision: revision,
      idempotency_key: "oversized-page-commit",
      patches: oversizedPatches,
    }),
    (error) => error instanceof LlmWikiError && error.code === "PAGE_COMMIT_TOO_LARGE",
  )
})

test("invalid SourceRefs, page traversal, symlinks, and stale hashes are rejected", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const symlinkPath = path.join(f.incoming, "linked.md")
  await symlink(f.source, symlinkPath)
  const partial = await f.core.importFiles({ files: [{ path: f.source }, { path: symlinkPath }] })
  assert.equal(partial.accepted.length, 1)
  assert.equal(partial.rejected[0].code, "SOURCE_NOT_READABLE")

  const firstBatch = await f.core.getBatch({ task_id: partial.task_id })
  const invalid = analysisFor(partial.task_id, firstBatch).analysis
  invalid.sourceRefs[0].chunkId = "chunk-forged"
  await assert.rejects(
    () => f.core.commitAnalysis({ task_id: partial.task_id, batch_id: firstBatch.batch_id, analysis: invalid, idempotency_key: "invalid-analysis-ref" }),
    (error) => error instanceof LlmWikiError && error.code === "INVALID_SOURCE_REF",
  )

  const sourceRef = await analyzeAll(f.core, partial)
  const plan = await f.core.getPagePlanContext({ task_id: partial.task_id })
  await assert.rejects(
    () => f.core.commitPages({
      task_id: partial.task_id,
      based_on_wiki_revision: plan.based_on_wiki_revision,
      idempotency_key: "bad-path-commit",
      patches: [{ patchId: "bad", path: "wiki/concepts/../../escape.md", operation: "create", title: "Bad", pageKind: "concept", content: "# Bad", sourceRefs: [sourceRef], rationale: "test" }],
    }),
    (error) => error instanceof LlmWikiError && error.code === "INVALID_PAGE_PATH",
  )

  const create = await f.core.commitPages({
    task_id: partial.task_id,
    based_on_wiki_revision: plan.based_on_wiki_revision,
    idempotency_key: "create-conflict-page",
    patches: [{ patchId: "page-v1", path: "wiki/concepts/conflict.md", operation: "create", title: "Conflict", pageKind: "concept", content: "# Conflict\n\nVersion one.", covers: plan.page_requirements.map((requirement) => requirement.requirement_id), sourceRefs: [sourceRef], rationale: "test" }],
  })
  const oldHash = create.written_pages[0].file_hash
  const latestPlan = await f.core.getPagePlanContext({ task_id: partial.task_id })
  await writeFile(path.join(f.workspace, "wiki", "concepts", "conflict.md"), "# Conflict\n\nExternal edit.\n")
  const rebasedPlan = await f.core.getPagePlanContext({ task_id: partial.task_id })
  await assert.rejects(
    () => f.core.commitPages({
      task_id: partial.task_id,
      based_on_wiki_revision: rebasedPlan.based_on_wiki_revision,
      idempotency_key: "stale-file-hash",
      patches: [{ patchId: "page-v2", path: "wiki/concepts/conflict.md", operation: "replace", expectedFileHash: oldHash, title: "Conflict", pageKind: "concept", content: "# Conflict\n\nVersion two.", covers: plan.page_requirements.map((requirement) => requirement.requirement_id), sourceRefs: [sourceRef], rationale: "test" }],
    }),
    (error) => error instanceof LlmWikiError && error.code === "FILE_HASH_CONFLICT",
  )
  assert.notEqual(latestPlan.based_on_wiki_revision, rebasedPlan.based_on_wiki_revision)
  assert.match(await readFile(path.join(f.workspace, "wiki", "concepts", "conflict.md"), "utf8"), /External edit/)

  const currentPage = rebasedPlan.existing_pages.find((page) => page.path === "wiki/concepts/conflict.md")
  const replaced = await f.core.commitPages({
    task_id: partial.task_id,
    based_on_wiki_revision: rebasedPlan.based_on_wiki_revision,
    idempotency_key: "successful-page-replace",
    patches: [{ patchId: "page-v3", path: "wiki/concepts/conflict.md", operation: "replace", expectedFileHash: currentPage.file_hash, title: "Conflict", pageKind: "concept", content: "# Conflict\n\nRebased version.", covers: plan.page_requirements.map((requirement) => requirement.requirement_id), sourceRefs: [sourceRef], rationale: "test successful optimistic replace" }],
  })
  assert.equal(replaced.accepted, true)
  assert.match(await readFile(path.join(f.workspace, "wiki", "concepts", "conflict.md"), "utf8"), /Rebased version/)
})
