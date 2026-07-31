import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
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
  const imported = await f.core.importFiles({
    files: [{ path: domainSource }],
    options: { domain_schema_path: domainSchemaPath },
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
  const committed = await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    analysis,
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
  const retrieval = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: "batch-0001", queries: ["Business Entity"], channels: ["bm25", "vector", "graph"] })
  assert.deepEqual(retrieval.available_channels, ["bm25", "vector", "graph"])
  assert.deepEqual(retrieval.pending_channels, [])

  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  assert.equal(plan.analysis_summary.claims.length, 1)
  assert.equal(plan.page_patch_schema.properties.path.type, "string")
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
      sourceRefs: [sourceRef],
      rationale: "The source explicitly defines this concept.",
    }],
  })
  assert.equal(committed.accepted, true)

  const result = await f.core.finalize({ task_id: imported.task_id })
  assert.equal(result.status, "completed")
  assert.equal(result.indexing.bm25, "completed")
  assert.equal(result.indexing.vector, "completed")
  assert.deepEqual(result.created_pages, ["wiki/concepts/business-entity.md"])
  assert.equal((await f.core.status({ task_id: imported.task_id })).status, "completed")
  assert.match(await readFile(path.join(f.workspace, "wiki", "index.md"), "utf8"), /Business Entity/)
  assert.match(await readFile(path.join(f.workspace, "wiki", "overview.md"), "utf8"), new RegExp(imported.task_id))
  assert.equal((await readFile(path.join(f.workspace, imported.sources[0].managed_path), "utf8")).includes("Product Model"), true)
  const again = await f.core.finalize({ task_id: imported.task_id })
  assert.deepEqual(again, result)
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
    patches: [{ patchId: "page-v1", path: "wiki/concepts/conflict.md", operation: "create", title: "Conflict", pageKind: "concept", content: "# Conflict\n\nVersion one.", sourceRefs: [sourceRef], rationale: "test" }],
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
      patches: [{ patchId: "page-v2", path: "wiki/concepts/conflict.md", operation: "replace", expectedFileHash: oldHash, title: "Conflict", pageKind: "concept", content: "# Conflict\n\nVersion two.", sourceRefs: [sourceRef], rationale: "test" }],
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
    patches: [{ patchId: "page-v3", path: "wiki/concepts/conflict.md", operation: "replace", expectedFileHash: currentPage.file_hash, title: "Conflict", pageKind: "concept", content: "# Conflict\n\nRebased version.", sourceRefs: [sourceRef], rationale: "test successful optimistic replace" }],
  })
  assert.equal(replaced.accepted, true)
  assert.match(await readFile(path.join(f.workspace, "wiki", "concepts", "conflict.md"), "utf8"), /Rebased version/)
})
