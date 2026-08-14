import assert from "node:assert/strict"
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { LlmWikiCore, LlmWikiError } from "../src/index.js"

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

async function publishTestWiki(workspace, suffix) {
  const generationId = `generation-00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`
  const generationRoot = path.join(workspace, ".llm-wiki", "generations", generationId)
  await mkdir(generationRoot, { recursive: true })
  await cp(path.join(workspace, "wiki"), path.join(generationRoot, "wiki"), { recursive: true })
  await writeFile(path.join(generationRoot, "manifest.json"), JSON.stringify({ schemaVersion: 1, generationId, taskId: "task-test-published", wikiRevision: `wiki-${suffix}`, pages: [], artifacts: {} }))
  await writeFile(path.join(workspace, ".llm-wiki", "current-generation.json"), JSON.stringify({ schema_version: 1, generation_id: generationId }))
}

function analysisFor(taskId, batch) {
  const chunk = batch.chunks.find((item) => item.text.includes("Business Entity is the canonical business object."))
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

test("server-generated evidence indexes avoid quote transcription and persist compact exact SourceRefs", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  const evidenceIndex = batch.evidence_catalog.findIndex((entry) => entry.quote === "Business Entity is the canonical business object.")
  assert.equal(evidenceIndex >= 0, true)
  assert.equal(batch.analysis_scaffold.sourceRefMode, "batch-evidence-index")
  assert.deepEqual(batch.analysis_scaffold.sourceRefs, batch.evidence_catalog.map((entry) => entry.evidence_index))
  assert.equal(batch.analysis_contract.required_fields.includes("sourceRefMode"), true)
  assert.match(batch.analysis_contract.source_refs, /use only evidence_catalog\.evidence_index integers/)

  const committed = await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    idempotency_key: "server-evidence-index-v1",
    analysis: {
      ...batch.analysis_scaffold,
      entities: [{ localId: "entity-business", name: "Business Entity", sourceRefs: [evidenceIndex] }],
      batchSummary: "Defines Business Entity.",
    },
  })
  assert.equal(committed.accepted, true)
  assert.equal(committed.normalized_source_ref_indexes, 1)
  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  assert.equal(plan.analysis_summary.entities[0].sourceRefs[0].quote, "Business Entity is the canonical business object.")
})

test("analysis normalization safely repairs omitted evidence mode and numeric confidence strings", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  const evidenceIndex = batch.evidence_catalog.findIndex((entry) => entry.quote === "Business Entity is the canonical business object.")
  const { sourceRefMode: _sourceRefMode, ...scaffoldWithoutMode } = batch.analysis_scaffold

  await assert.rejects(
    () => f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      idempotency_key: "unsafe-analysis-normalization-v0",
      analysis: {
        ...scaffoldWithoutMode,
        entities: [{ localId: "entity-business", name: "Business Entity", confidence: "91%", sourceRefs: [evidenceIndex] }],
      },
    }),
    (error) => error?.code === "INVALID_ANALYSIS"
      && error.details.validation_errors.includes("entities[0].confidence must be between 0 and 1"),
  )

  const committed = await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    idempotency_key: "safe-analysis-normalization-v1",
    analysis: {
      ...scaffoldWithoutMode,
      entities: [{ localId: "entity-business", name: "Business Entity", confidence: "0.91", sourceRefs: [evidenceIndex] }],
      candidatePages: [{ localId: "page-business", title: "Business Entity", confidence: "0.8", sourceRefs: [evidenceIndex] }],
      batchSummary: "Defines Business Entity.",
    },
  })

  assert.equal(committed.accepted, true)
  assert.equal(committed.inferred_batch_evidence_mode, true)
  assert.equal(committed.normalized_numeric_confidences, 2)
  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  assert.equal(plan.analysis_summary.entities[0].confidence, 0.91)
  assert.equal(plan.candidate_pages[0].confidence, 0.8)
  assert.equal(plan.analysis_summary.entities[0].sourceRefs[0].quote, "Business Entity is the canonical business object.")
})

test("legacy hand-written quotes are canonicalized only after a unique safe match", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await writeFile(f.source, "# 客户\n\n客户张三的客户编号为 **C1001**，客户类别为“个人客户”。\n")
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  const chunk = batch.chunks[0]
  const sourceRef = {
    ...chunk.source_ref_templates[0],
    quote: '客户张三的客户编号为 C1001，客户类别为"个人客户"。',
  }
  const committed = await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    idempotency_key: "canonical-legacy-quote-v1",
    analysis: {
      schemaVersion: 1,
      taskId: imported.task_id,
      batchId: batch.batch_id,
      sourceRefs: [sourceRef],
      entities: [{ localId: "customer-1", name: "张三", sourceRefs: [0] }],
      concepts: [], claims: [], relations: [], contradictions: [], candidatePages: [], reviewItems: [],
      batchSummary: "客户资料。",
      unresolvedQuestions: [],
    },
  })
  assert.equal(committed.accepted, true)
  assert.equal(committed.normalized_source_ref_quotes, 1)
  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  assert.equal(plan.analysis_summary.entities[0].sourceRefs[0].quote, "客户张三的客户编号为 **C1001**，客户类别为“个人客户”。")
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
      && error.details.quality_gate === "source-ref-grounding-v2"
      && error.details.grounding_diagnostics.some((diagnostic) => ["INSUFFICIENT_LEXICAL_SUPPORT", "UNSUPPORTED_STRONG_ANCHOR"].includes(diagnostic.reason_code))
      && error.details.grounding_warnings.some((warning) => warning.reason_code === "HIGH_SOURCE_REF_REUSE"),
  )
  assert.equal((await f.core.status({ task_id: imported.task_id })).status, "prepared")
})

test("grounding accepts exact relation content from server evidence without label dilution", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await writeFile(f.source, "# 关系\n\n6. B4001 为 S3001 付费。\n7. A2001 登录并访问 S3001。\n")
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  const paysEvidence = batch.evidence_catalog.find((entry) => entry.quote.includes("B4001 为 S3001 付费"))
  const accessesEvidence = batch.evidence_catalog.find((entry) => entry.quote.includes("A2001 登录并访问 S3001"))
  assert.ok(paysEvidence)
  assert.ok(accessesEvidence)

  const committed = await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    idempotency_key: "exact-relation-evidence-v1",
    analysis: {
      ...batch.analysis_scaffold,
      relations: [
        {
          localId: "b4001-pays-s3001",
          name: "billing_account_pays_for_subscription 账务账户为订购实例付费",
          content: "B4001 为 S3001 付费。",
          sourceRefs: [paysEvidence.evidence_index],
        },
        {
          localId: "a2001-accesses-s3001",
          name: "service_account_accesses_subscription 业务账户访问订购实例",
          content: "A2001 登录并访问 S3001。",
          sourceRefs: [accessesEvidence.evidence_index],
        },
      ],
      batchSummary: "账户与订购实例的关系。",
    },
  })
  assert.equal(committed.accepted, true)
})


test("real embedding recall is cached and endpoint failures degrade without failing retrieval", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const semanticSource = path.join(f.incoming, "semantic.md")
  await writeFile(semanticSource, "# Transport\n\nAn automobile carries passengers between cities.\n")
  let requests = 0
  let endpointUnavailable = false
  let endpointMalformed = false
  let endpointNonStreaming = false
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (_url, options) => {
    requests += 1
    if (endpointUnavailable) throw new Error("endpoint unavailable")
    if (endpointNonStreaming) return { ok: true, status: 200, headers: { get: () => null }, body: null }
    const payload = JSON.parse(options.body)
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input]
    return new Response(JSON.stringify({
      data: endpointMalformed === "empty" ? [] : inputs.map((input, index) => ({
        index: endpointMalformed === "bad-index" ? 99 : index,
        embedding: /\b(car|automobile)\b/i.test(input) ? [1, 0, 0] : [0, 1, 0],
      })),
    }), { status: 200, headers: { "content-type": "application/json" } })
  }
  const endpoint = "http://embedding.test/v1/embeddings"
  await f.core.init()
  const configPath = path.join(f.workspace, ".llm-wiki", "config.json")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.retrieval.embedding = { provider: "openai-compatible", model: "test-embedding", endpoint, batchSize: 8, maxDocuments: 100 }
  await writeFile(configPath, JSON.stringify(config))
  const imported = await f.core.importFiles({ files: [{ path: semanticSource }] })
  for (let attempt = 0; attempt < 50 && requests === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const batch = await f.core.getBatch({ task_id: imported.task_id })

  const first = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: batch.batch_id, queries: ["car"], channels: ["bm25", "embedding", "wiki"] })
  assert.equal(first.channel_status.embedding.mode, "embedding")
  assert.equal(first.hits.some((hit) => hit.kind === "source-chunk" && hit.snippet.includes("automobile")), true)
  assert.equal(first.corpus.by_kind["source-chunk"] > 0, true)
  const requestsAfterFirst = requests
  const second = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: batch.batch_id, queries: ["car"], channels: ["embedding"] })
  assert.equal(second.channel_status.embedding.cache_hits > 0, true)
  assert.equal(requests - requestsAfterFirst, 1)

  endpointMalformed = "empty"
  const malformed = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: batch.batch_id, queries: ["car"], channels: ["embedding"] })
  assert.equal(malformed.channel_status.feature_hash.mode, "feature-hash-fallback")
  assert.equal(malformed.channel_status.feature_hash.reason, "EMBEDDING_INVALID_RESPONSE")

  endpointMalformed = "bad-index"
  const malformedIndex = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: batch.batch_id, queries: ["car"], channels: ["embedding"] })
  assert.equal(malformedIndex.channel_status.feature_hash.mode, "feature-hash-fallback")
  assert.equal(malformedIndex.channel_status.feature_hash.reason, "EMBEDDING_INVALID_RESPONSE")

  endpointMalformed = false
  endpointUnavailable = true
  const degraded = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: batch.batch_id, queries: ["car"], channels: ["embedding"] })
  assert.equal(degraded.channel_status.feature_hash.mode, "feature-hash-fallback")
  assert.equal(degraded.channel_status.feature_hash.degraded, true)
  assert.equal(Array.isArray(degraded.hits), true)

  endpointUnavailable = false
  endpointNonStreaming = true
  const nonStreaming = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: batch.batch_id, queries: ["car"], channels: ["embedding"] })
  assert.equal(nonStreaming.channel_status.feature_hash.mode, "feature-hash-fallback")
  assert.equal(nonStreaming.channel_status.feature_hash.reason, "EMBEDDING_INVALID_RESPONSE")
})

test("Wiki title and bidirectional link neighbors participate in RRF", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const topics = path.join(f.workspace, "wiki", "topics")
  await mkdir(topics, { recursive: true })
  await writeFile(path.join(topics, "alpha.md"), "# AlphaTerm\n\nSee [[topics/hidden-neighbor]].\n")
  await writeFile(path.join(topics, "hidden-neighbor.md"), "# Hidden Neighbor\n\nLinked background knowledge.\n")
  await publishTestWiki(f.workspace, 2)
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

test("Wiki retrieval graph ignores links inside Markdown code examples", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const topics = path.join(f.workspace, "wiki", "topics")
  await mkdir(topics, { recursive: true })
  await writeFile(path.join(topics, "alpha.md"), "# AlphaCodeExample\n\n```markdown\n[[topics/hidden-neighbor]]\n```\n")
  await writeFile(path.join(topics, "hidden-neighbor.md"), "# Hidden Neighbor\n\nUnrelated background knowledge.\n")
  await publishTestWiki(f.workspace, 3)
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  const retrieval = await f.core.retrieveContext({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    queries: ["AlphaCodeExample"],
    channels: ["bm25", "wiki"],
  })
  assert.equal(retrieval.hits.some((hit) => hit.path === "wiki/topics/alpha.md"), true)
  assert.equal(retrieval.hits.some((hit) => hit.path === "wiki/topics/hidden-neighbor.md"), false)
})

test("page planning resolves safe cross-batch local IDs into bidirectional Related scaffolds", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const alphaSource = path.join(f.incoming, "alpha.md")
  const betaSource = path.join(f.incoming, "beta.md")
  await writeFile(alphaSource, `# Alpha\n\nAlpha service is defined. ${"alpha ".repeat(150)}\n`)
  await writeFile(betaSource, `# Beta\n\nBeta depends on Alpha service. ${"beta ".repeat(150)}\n`)
  const imported = await f.core.importFiles({
    files: [{ path: alphaSource }, { path: betaSource }],
    options: { max_batch_chars: 1_000 },
  })
  assert.equal(imported.batch_count >= 2, true)

  while (true) {
    const batch = await f.core.getBatch({ task_id: imported.task_id, worker_id: "cross-batch-worker" })
    if (batch.completed) break
    const alphaEvidence = batch.evidence_catalog.find((entry) => entry.quote.includes("Alpha service is defined"))
    const betaEvidence = batch.evidence_catalog.find((entry) => entry.quote.includes("Beta depends on Alpha service"))
    const analysis = { ...batch.analysis_scaffold, batchSummary: "Cross-batch relation fixture." }
    if (alphaEvidence) {
      analysis.entities = [{ localId: "stable-alpha", name: "Alpha service", sourceRefs: [alphaEvidence.evidence_index] }]
    }
    if (betaEvidence) {
      analysis.entities = [{ localId: "stable-beta", name: "Beta", sourceRefs: [betaEvidence.evidence_index] }]
      analysis.relations = [{
        localId: "beta-depends-alpha",
        content: "Beta depends on Alpha service.",
        sourceEntityLocalId: "stable-beta",
        targetEntityLocalId: "stable-alpha",
        sourceRefs: [betaEvidence.evidence_index],
      }]
    }
    const committed = await f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      worker_id: batch.worker_id,
      lease_token: batch.lease_token,
      analysis,
      idempotency_key: `cross-batch-related-${batch.batch_id}`,
    })
    assert.equal(committed.accepted, true)
  }

  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  const alpha = plan.page_requirements.find((requirement) => requirement.title === "Alpha service")
  const beta = plan.page_requirements.find((requirement) => requirement.title === "Beta")
  assert.ok(alpha)
  assert.ok(beta)
  assert.deepEqual(alpha.related_requirement_ids, [beta.requirement_id])
  assert.deepEqual(beta.related_requirement_ids, [alpha.requirement_id])
  assert.deepEqual(alpha.patch_scaffold.related, ["entities/beta"])
  assert.deepEqual(beta.patch_scaffold.related, ["entities/alpha-service"])
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
  assert.equal(buildingRetrieval.retrieval_phase, "source-ready")
  assert.deepEqual(buildingRetrieval.available_channels, ["bm25"])
  assert.deepEqual(buildingRetrieval.fallback_channels, ["feature_hash"])
  const retrieval = await f.core.retrieveContext({ task_id: imported.task_id, batch_id: "batch-0001", queries: ["Business Entity"], channels: ["bm25", "embedding", "wiki"] })
  assert.deepEqual(retrieval.available_channels, ["bm25"])
  assert.deepEqual(retrieval.pending_channels, ["embedding", "wiki"])
  assert.deepEqual(retrieval.fallback_channels, ["feature_hash"])

  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  assert.equal(plan.analysis_summary.claims.length, 1)
  assert.equal(plan.page_patch_schema.properties.path.type, "string")
  assert.equal(plan.page_requirements.some((requirement) => requirement.title === "Aggregate"), true)
  assert.equal(plan.page_requirements.some((requirement) => requirement.title === "Business Entity"), true)
  assert.equal(plan.page_requirements.some((requirement) => requirement.title.startsWith("Claim: Business Entity is the canonical business object.")), true)
  const businessRequirement = plan.page_requirements.find((requirement) => requirement.title === "Business Entity")
  const aggregateRequirement = plan.page_requirements.find((requirement) => requirement.title === "Aggregate")
  const claimRequirement = plan.page_requirements.find((requirement) => requirement.title.startsWith("Claim: Business Entity is the canonical business object."))
  assert.deepEqual(businessRequirement.patch_scaffold.sourceRefs, [businessRequirement.requirement_id])
  assert.deepEqual(businessRequirement.patch_scaffold.covers, [businessRequirement.requirement_id])
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
      content: "# Business Entity\n\nA canonical business object.\n\n## Related\n\n- wiki/concepts/aggregate.md",
      summary: "The canonical business object.",
      tags: ["domain-model"],
      related: [],
      covers: [businessRequirement.requirement_id],
      sourceRefs: [businessRequirement.requirement_id],
      rationale: "The source explicitly defines this concept.",
    }, {
      patchId: "aggregate-v1",
      path: "wiki/concepts/aggregate.md",
      operation: "create",
      title: "Aggregate",
      pageKind: "concept",
      content: "# Aggregate\n\nAn Aggregate groups related Business Entities.",
      summary: "Groups related Business Entities.",
      tags: ["domain-model"],
      related: [],
      covers: [aggregateRequirement.requirement_id],
      sourceRefs: [aggregateRequirement.requirement_id],
      rationale: "The source explicitly defines Aggregate.",
    }, {
      ...claimRequirement.patch_scaffold,
      content: `# ${claimRequirement.title}\n\nBusiness Entity is the canonical business object.`,
      summary: "The source's canonical Business Entity claim.",
      tags: ["claim"],
    }],
  })
  assert.equal(committed.accepted, true)
  assert.equal(committed.normalized_page_requirement_source_refs, 3)

  const result = await f.core.finalize({ task_id: imported.task_id })
  assert.equal(result.status, "completed")
  assert.equal(result.indexing.bm25, "completed")
  assert.equal(result.indexing.feature_hash, "completed")
  assert.match(result.generation_id, /^generation-/)
  const generationPointer = JSON.parse(await readFile(path.join(f.workspace, ".llm-wiki", "current-generation.json"), "utf8"))
  assert.equal(generationPointer.generation_id, result.generation_id)
  assert.equal(generationPointer.wiki_revision, result.wiki_revision)
  const generationManifest = JSON.parse(await readFile(path.join(f.workspace, ".llm-wiki", "generations", result.generation_id, "manifest.json"), "utf8"))
  assert.equal(generationManifest.wikiRevision, result.wiki_revision)
  assert.equal(generationManifest.taskId, imported.task_id)
  assert.deepEqual(Object.keys(generationManifest.artifacts).sort(), ["bm25.json", "embedding.f32", "embedding.json", "feature-hash.f32", "feature-hash.json", "graph.json", "lint.json", "page-source-refs.json"])
  assert.equal(result.created_pages.includes("wiki/concepts/business-entity.md"), true)
  assert.equal(result.created_pages.includes("wiki/concepts/aggregate.md"), true)
  assert.equal(result.created_pages.includes(claimRequirement.patch_scaffold.path), true)
  assert.equal((await f.core.status({ task_id: imported.task_id })).status, "completed")
  assert.match(await readFile(path.join(f.workspace, "wiki", "index.md"), "utf8"), /Business Entity/)
  assert.match(await readFile(path.join(f.workspace, "wiki", "index.md"), "utf8"), /## Concepts/)
  assert.match(await readFile(path.join(f.workspace, "wiki", "overview.md"), "utf8"), new RegExp(imported.task_id))
  const businessPage = await readFile(path.join(f.workspace, "wiki", "concepts", "business-entity.md"), "utf8")
  const aggregatePage = await readFile(path.join(f.workspace, "wiki", "concepts", "aggregate.md"), "utf8")
  assert.match(businessPage, /related: \["concepts\/aggregate"/)
  assert.doesNotMatch(businessPage, /wiki\/concepts\/aggregate\.md/)
  assert.match(businessPage, /\[\[concepts\/aggregate\]\]/)
  assert.match(businessPage, /covers: \["page-/)
  assert.match(aggregatePage, /related: \["concepts\/business-entity"/)
  assert.match(aggregatePage, /\[\[concepts\/business-entity\]\]/)
  assert.equal((await readFile(path.join(f.workspace, imported.sources[0].managed_path), "utf8")).includes("Product Model"), true)
  const completedRetrieval = await f.core.retrieveContext({ task_id: imported.task_id, queries: ["Business Entity"] })
  assert.equal(completedRetrieval.retrieval_phase, "knowledge-base-complete")
  assert.deepEqual(completedRetrieval.available_channels, ["bm25", "wiki"])
  assert.deepEqual(completedRetrieval.fallback_channels, ["feature_hash"])
  const again = await f.core.finalize({ task_id: imported.task_id })
  assert.deepEqual(again, result)
})

test("completed Wiki supports inspected, grounded, idempotent section updates with generation publication", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const sourceRef = await analyzeAll(f.core, imported)
  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  const businessRequirement = plan.page_requirements.find((requirement) => requirement.title === "Business Entity")
  assert.ok(businessRequirement)
  await f.core.commitPages({
    task_id: imported.task_id,
    based_on_wiki_revision: plan.based_on_wiki_revision,
    idempotency_key: "incremental-update-pages-v1",
    patches: plan.page_requirements.map((requirement) => ({
      ...requirement.patch_scaffold,
      content: `# ${requirement.title}\n\n## Details\n\nInitial ${requirement.title} details.`,
      rationale: `Create ${requirement.title} for incremental update testing.`,
    })),
  })
  const finalized = await f.core.finalize({ task_id: imported.task_id })
  const targetPath = businessRequirement.patch_scaffold.path
  const inspected = await f.core.updatePages({
    task_id: imported.task_id,
    action: "inspect",
    targets: [{ path: targetPath, heading: "Details" }],
  })
  assert.equal(inspected.action, "inspect")
  assert.equal(inspected.wiki_revision, finalized.wiki_revision)
  assert.match(inspected.pages[0].section.content, /Initial Business Entity details/)
  assert.match(inspected.pages[0].file_hash, /^[0-9a-f]{64}$/)

  const applyInput = {
    task_id: imported.task_id,
    action: "apply",
    based_on_wiki_revision: inspected.wiki_revision,
    idempotency_key: "incremental-section-apply-v1",
    updates: [{
      update_id: "business-details-v2",
      path: targetPath,
      expected_file_hash: inspected.pages[0].file_hash,
      changes: [
        { operation: "replace_section", heading: "Details", content: "Updated grounded Business Entity details." },
        { operation: "upsert_section", heading: "Operations", level: 2, content: "Operational guidance for Business Entity." },
      ],
      source_refs: [sourceRef],
      rationale: "Incrementally refresh the completed Wiki page.",
    }],
  }
  const updated = await f.core.updatePages(applyInput)
  assert.equal(updated.accepted, true)
  assert.equal(updated.idempotent_replay, false)
  assert.notEqual(updated.generation_id, finalized.generation_id)
  assert.notEqual(updated.wiki_revision, inspected.wiki_revision)
  assert.deepEqual(updated.written_pages[0].changed_sections.map((item) => item.operation), ["replace_section", "upsert_section"])
  const page = await readFile(path.join(f.workspace, targetPath), "utf8")
  assert.match(page, /## Details\n\nUpdated grounded Business Entity details\./)
  assert.doesNotMatch(page, /Initial Business Entity details/)
  assert.match(page, /## Operations\n\nOperational guidance for Business Entity\./)
  const pointer = JSON.parse(await readFile(path.join(f.workspace, ".llm-wiki", "current-generation.json"), "utf8"))
  assert.equal(pointer.generation_id, updated.generation_id)
  assert.equal(pointer.wiki_revision, updated.wiki_revision)

  const replay = await f.core.updatePages(applyInput)
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.transaction_id, updated.transaction_id)
  await assert.rejects(
    () => f.core.updatePages({
      ...applyInput,
      idempotency_key: "incremental-section-stale-v1",
    }),
    (error) => error instanceof LlmWikiError && error.code === "FILE_HASH_CONFLICT",
  )
})

test("page commits repair legacy quote formatting and prefer requirement-ID SourceRefs", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await writeFile(f.source, "# 客户\n\n客户张三的客户编号为 **C1001**，客户类别为“个人客户”。\n")
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id })
  const evidence = batch.evidence_catalog.find((entry) => entry.quote.includes("客户张三"))
  assert.ok(evidence)
  await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    idempotency_key: "page-quote-analysis-v1",
    analysis: {
      ...batch.analysis_scaffold,
      entities: [{ localId: "customer-zhang-san", name: "张三", sourceRefs: [evidence.evidence_index] }],
      batchSummary: "客户张三的资料。",
    },
  })
  const plan = await f.core.getPagePlanContext({ task_id: imported.task_id })
  const requirement = plan.page_requirements[0]
  assert.deepEqual(requirement.patch_scaffold.sourceRefs, [requirement.requirement_id])
  const reconstructedRef = {
    ...requirement.source_refs[0],
    quote: '客户张三的客户编号为 C1001，客户类别为"个人客户"。',
  }
  const committed = await f.core.commitPages({
    task_id: imported.task_id,
    based_on_wiki_revision: plan.based_on_wiki_revision,
    idempotency_key: "page-quote-repair-v1",
    patches: [{
      ...requirement.patch_scaffold,
      content: "# 张三\n\n客户编号为 C1001。",
      sourceRefs: [reconstructedRef],
    }],
  })
  assert.equal(committed.accepted, true)
  assert.equal(committed.normalized_page_source_ref_quotes, 1)
})

test("single-batch tasks still require a background extractor", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  assert.equal(imported.batch_count, 1)
  assert.equal(imported.parallel_extraction.enabled, true)
  assert.equal(imported.parallel_extraction.required, true)
  assert.equal(imported.parallel_extraction.mode, "background-agent-first")
  assert.equal(imported.parallel_extraction.single_batch_background, true)
  assert.equal(imported.parallel_extraction.recommended_workers, 1)
  assert.equal(imported.subagent_recovery.process_liveness_known, false)
  assert.equal(imported.subagent_recovery.roles.extractor.desired_live_invocations, 1)
  assert.equal(imported.subagent_recovery.roles.drafter.desired_live_invocations, 0)
  assert.equal(imported.subagent_recovery.roles.writer.desired_live_invocations, 0)
  const status = await f.core.status({ task_id: imported.task_id })
  assert.equal(status.parallel_extraction.enabled, true)
  assert.equal(status.parallel_extraction.required, true)
  assert.equal(status.parallel_extraction.single_batch_background, true)
})

test("Finalize before extraction starts routes to exact automatic catch-up", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  await assert.rejects(
    () => f.core.finalize({ task_id: imported.task_id }),
    (error) => error instanceof LlmWikiError
      && error.code === "FINALIZE_CATCHUP_REQUIRED"
      && error.details.remaining_extraction_batches === 1
      && error.details.next_action.tool === "llm_wiki_get_batch"
      && error.details.completion_gate.automatic_continuation_required === true
      && error.details.completion_gate.user_confirmation_required === false,
  )
})

test("failed tasks with unfinished extraction do not loop Finalize or relaunch Extractors", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const taskPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "task.json")
  const task = JSON.parse(await readFile(taskPath, "utf8"))
  task.status = "failed"
  task.lastError = { code: "SYNTHETIC_IMPORT_FAILURE", message: "Synthetic partial progressive import failure." }
  await writeFile(taskPath, JSON.stringify(task))

  const status = await f.core.status({ task_id: imported.task_id })
  assert.equal(status.parallel_extraction.enabled, false)
  assert.equal(status.worker_recovery.resumable, false)
  assert.equal(status.subagent_recovery.roles.extractor.work_remaining, false)
  assert.equal(status.subagent_recovery.roles.extractor.desired_live_invocations, 0)
  assert.equal(status.next_action, null)
  assert.equal(status.completion_gate.automatic_continuation_required, false)
  assert.equal(status.completion_gate.finalize_ready, false)
  await assert.rejects(
    () => f.core.finalize({ task_id: imported.task_id }),
    (error) => error instanceof LlmWikiError
      && error.code === "FINALIZE_CATCHUP_REQUIRED"
      && error.details.next_action === null
      && error.details.completion_gate.automatic_continuation_required === false,
  )
})

test("one background slot is shared by extraction and projection roles", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const files = []
  for (let index = 0; index < 8; index += 1) {
    const file = path.join(f.incoming, `single-slot-${index}.md`)
    await writeFile(file, `# Business Entity ${index}\n\n${"Business Entity is the canonical business object. ".repeat(18)}`)
    files.push({ path: file })
  }
  const imported = await f.core.importFiles({
    files,
    options: { max_batch_chars: 1_000, host_capabilities: { max_total_agents: 2, coordinator_slots: 1 } },
  })
  for (let index = 0; index < 4; index += 1) {
    const batch = await f.core.getBatch({ task_id: imported.task_id, worker_id: `single-slot-worker-${index}` })
    const evidence = batch.evidence_catalog.find((entry) => entry.quote.includes("Business Entity"))
    await f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      worker_id: batch.worker_id,
      lease_token: batch.lease_token,
      idempotency_key: `single-slot-analysis-${index}`,
      analysis: {
        ...batch.analysis_scaffold,
        entities: [{ localId: `single-slot-entity-${index}`, name: "Business Entity", confidence: 0.9, sourceRefs: [evidence.evidence_index] }],
        batchSummary: "Defines Business Entity.",
      },
    })
  }
  const manifest = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "single-slot-writer", view: "manifest" })
  assert.equal(manifest.draft_manifest.pending_shard_count > 0, true)
  const status = await f.core.status({ task_id: imported.task_id })
  const roles = status.subagent_recovery.roles
  const desired = roles.extractor.desired_live_invocations
    + roles.drafter.desired_live_invocations
    + roles.writer.desired_live_invocations
  assert.equal(status.pipeline_concurrency.max_background_agents_total, 1)
  assert.equal(roles.extractor.desired_live_invocations, 0)
  assert.equal(roles.drafter.desired_live_invocations, 1)
  assert.equal(desired, 1)
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
  const imported = await f.core.importFiles({
    files,
    options: { max_batch_chars: 1_000, host_capabilities: { max_total_agents: 5, coordinator_slots: 1 } },
  })
  assert.equal(imported.batch_count > 1, true)
  assert.equal(imported.parallel_extraction.recommended_workers, Math.min(4, imported.batch_count))
  assert.equal(imported.parallel_extraction.worker_batch_quantum, Math.min(6, Math.ceil(imported.batch_count / imported.parallel_extraction.recommended_workers)))
  assert.equal(imported.parallel_extraction.checkpoint_each_batch, true)
  const workerCount = imported.batch_count
  const workerCores = await Promise.all(Array.from({ length: workerCount }, () => LlmWikiCore.open(f.workspace)))
  const leased = await Promise.all(Array.from({ length: workerCount }, (_, index) => (
    workerCores[index].getBatch({ task_id: imported.task_id, worker_id: `worker-${index}` })
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
    return workerCores[index].commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      worker_id: batch.worker_id,
      lease_token: batch.lease_token,
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
  assert.equal(status.worker_recovery.resumable, false)
  assert.equal(status.worker_recovery.strategy, "none")
  assert.equal(status.worker_recovery.process_liveness_known, false)
  assert.equal(status.worker_recovery.leases_are_live_agents, false)
  assert.equal(status.status, "planning")
  const idempotencyFiles = await readdir(path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "idempotency"))
  assert.equal(idempotencyFiles.filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).length, workerCount)
  assert.equal(idempotencyFiles.includes("version.json"), true)
  assert.deepEqual(JSON.parse(await readFile(path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "idempotency.json"), "utf8")), {})
})

test("large tasks use compact 9K batches, cached bounds, and longer worker quanta", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const source = path.join(f.incoming, "large-throughput.md")
  const rows = Array.from({ length: 4_000 }, (_, index) => `| customer-${index} | account-${index} | product-${index} |`)
  await writeFile(source, `# Large throughput\n\n| Customer | Account | Product |\n| --- | --- | --- |\n${rows.join("\n")}\n`)
  const imported = await f.core.importFiles({ files: [{ path: source }] })
  assert.equal(imported.parallel_extraction.recommended_batch_chars, 9_000)
  assert.equal(imported.parallel_extraction.worker_batch_quantum, 6)

  const batchesPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "batches.json")
  const persisted = JSON.parse(await readFile(batchesPath, "utf8"))
  assert.equal(persisted.every((batch) => batch.charCount <= 9_000 && batch.payloadBytes <= 24 * 1024), true)
  assert.equal(persisted.flatMap((batch) => batch.chunks).every((chunk) => chunk.taskPayloadVersion === 3), true)
  assert.equal(persisted.flatMap((batch) => batch.chunks).flatMap((chunk) => chunk.structuredData ?? [])
    .every((table) => table.compacted === true && table.markdown === undefined && table.rows === undefined), true)

  const before = await stat(batchesPath, { bigint: true })
  const first = await f.core.getBatch({
    task_id: imported.task_id,
    worker_id: "large-throughput-worker",
    max_chars: imported.parallel_extraction.recommended_batch_chars,
  })
  const second = await f.core.getBatch({
    task_id: imported.task_id,
    worker_id: "large-throughput-worker",
    max_chars: imported.parallel_extraction.recommended_batch_chars,
  })
  const after = await stat(batchesPath, { bigint: true })
  assert.equal(first.batch_id, second.batch_id)
  assert.equal(first.batch_limits.char_count <= 9_000, true)
  assert.equal(first.batch_limits.payload_bytes <= 24 * 1024, true)
  assert.equal(first.batch_limits.complete_response_bytes < 40 * 1024, true)
  assert.equal(before.mtimeNs, after.mtimeNs)
})

test("a worker invocation can resume its leased batch by stable worker ID after a turn boundary", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const leased = await f.core.getBatch({ task_id: imported.task_id, worker_id: "extractor-resume-1" })
  const status = await f.core.status({ task_id: imported.task_id })
  assert.equal(status.subagent_recovery.process_liveness_known, false)
  assert.equal(status.subagent_recovery.reconcile_before_waiting, true)
  assert.deepEqual(status.subagent_recovery.coordinator_live_sets, [
    "running_worker_ids",
    "running_draft_shard_ids",
    "running_writer_projection_ids",
  ])
  assert.equal(status.subagent_recovery.roles.extractor.work_remaining, true)
  assert.equal(status.subagent_recovery.roles.extractor.desired_live_invocations, 1)
  assert.equal(status.subagent_recovery.roles.extractor.persisted_reservations, 1)
  assert.equal(status.subagent_recovery.roles.extractor.reservations_are_live_invocations, false)
  assert.deepEqual(status.subagent_recovery.roles.extractor.resume_actions, [{
    tool: "llm_wiki_get_batch",
    action_owner: "extractor",
    delegate_to: "llm-wiki-extractor",
    arguments: {
      task_id: imported.task_id,
      worker_id: "extractor-resume-1",
      batch_id: leased.batch_id,
    },
  }])
  assert.equal(status.worker_recovery.leases_are_live_agents, false)
  assert.deepEqual(status.worker_recovery.leases.map(({ worker_id, batch_id }) => ({ worker_id, batch_id })), [{
    worker_id: "extractor-resume-1",
    batch_id: leased.batch_id,
  }])
  const resumed = await f.core.getBatch({ task_id: imported.task_id, worker_id: "extractor-resume-1" })
  assert.equal(resumed.batch_id, leased.batch_id)
  assert.deepEqual(resumed.chunks, leased.chunks)
})

test("a smaller get_batch request never repartitions another worker's live lease", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const largeSource = path.join(f.incoming, "lease-stability.md")
  const lines = Array.from({ length: 900 }, (_, index) => `Stable evidence row ${String(index).padStart(4, "0")} belongs to its leased batch.`)
  await writeFile(largeSource, `# Lease stability\n\n${lines.join("\n")}\n`)
  const imported = await f.core.importFiles({ files: [{ path: largeSource }], options: { max_batch_chars: 9_000 } })
  assert.equal(imported.batch_count > 2, true)

  const first = await f.core.getBatch({ task_id: imported.task_id, worker_id: "extractor-live-1", max_chars: 9_000 })
  const firstText = first.chunks.map((chunk) => chunk.text).join("\n")
  const second = await f.core.getBatch({ task_id: imported.task_id, worker_id: "extractor-live-2", max_chars: 6_000 })
  assert.notEqual(second.batch_id, first.batch_id)
  const taskRoot = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id)
  const persistedBatches = JSON.parse(await readFile(path.join(taskRoot, "batches.json"), "utf8"))
  const persistedFirst = persistedBatches.find((batch) => batch.batchId === first.batch_id)
  assert.equal(persistedFirst.chunks.map((chunk) => chunk.text).join("\n"), firstText)
  const unleased = persistedBatches.find((batch) => ![first.batch_id, second.batch_id].includes(batch.batchId))
  await assert.rejects(
    () => f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: unleased.batchId,
      worker_id: "extractor-unleased",
      idempotency_key: "unleased-analysis-v1",
      analysis: {},
    }),
    (error) => error instanceof LlmWikiError && error.code === "BATCH_LEASE_REQUIRED",
  )

  const evidence = first.evidence_catalog[0]
  const committed = await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: first.batch_id,
    worker_id: "extractor-live-1",
    lease_token: first.lease_token,
    idempotency_key: "lease-stability-commit-v1",
    analysis: {
      ...first.analysis_scaffold,
      entities: [{ localId: "lease-stability", name: evidence.quote, sourceRefs: [evidence.evidence_index] }],
      batchSummary: "Lease stability evidence.",
    },
  })
  assert.equal(committed.accepted, true)
  const replay = await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: first.batch_id,
    worker_id: "extractor-live-1",
    lease_token: first.lease_token,
    idempotency_key: "lease-stability-commit-v1",
    analysis: {
      ...first.analysis_scaffold,
      entities: [{ localId: "lease-stability", name: evidence.quote, sourceRefs: [evidence.evidence_index] }],
      batchSummary: "Lease stability evidence.",
    },
  })
  assert.equal(replay.idempotent_replay, true)
  await assert.rejects(
    () => f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: first.batch_id,
      worker_id: "extractor-live-1",
      lease_token: first.lease_token,
      idempotency_key: "lease-stability-commit-v1",
      analysis: { ...first.analysis_scaffold, batchSummary: "Changed request." },
    }),
    (error) => error instanceof LlmWikiError && error.code === "IDEMPOTENCY_CONFLICT",
  )
})

test("micro-batch Wiki projection uses one writer, hides provisional pages, and falls back after a failed final audit", async (t) => {
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
  assert.equal(imported.wiki_projection.writer_committers, 1)
  assert.deepEqual(imported.wiki_projection.parallel_page_drafting, {
    enabled: true,
    execution_mode: "coordinator-owned-parallel-drafters",
    fallback_mode: "serial-writer-only",
    writer_launch_policy: "after-staged-drafter-receipt",
    writer_normal_mode: "staged-receipt-commit-only",
    max_drafters: 3,
    max_paths_per_shard: 6,
    minimum_paths: 4,
    pipeline_background_budget: 3,
    max_background_agents_total: 3,
    extraction_workers_during_drafting: 2,
    max_drafters_when_extraction_overlaps: 1,
    partition_key: "patch_scaffold.path",
    drafter_handoff: "server-side-temporary-draft-receipt",
    stage_tool: "llm_wiki_stage_page_drafts",
    writer_commit_tool: "llm_wiki_commit_pages",
    commit_strategy: "single-writer-durable-waves",
  })
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
      lease_token: batch.lease_token,
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
  assert.deepEqual(ready.pipeline_concurrency, {
    max_background_agents_total: 3,
    recommended_extractors: 2,
    max_drafters: 1,
    recommended_drafters: 1,
  })
  assert.equal(ready.parallel_extraction.recommended_workers, 2)
  assert.equal(ready.parallel_extraction.restart_on_worker_completion, true)
  assert.equal(ready.parallel_extraction.restart_delay_ms, 0)
  assert.equal(projectionSignal.next_action.tool, "llm_wiki_get_page_plan_context")
  assert.equal(projectionSignal.worker_next_action.tool, "llm_wiki_get_batch")
  assert.deepEqual(projectionSignal.worker_restart, {
    required: true,
    strategy: "restart-same-worker-id-immediately",
    worker_id: projectionSignal.worker_next_action.arguments.worker_id,
    delay_ms: 0,
    action: projectionSignal.worker_next_action,
  })

  const incrementalPlan = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "wiki-writer-1" })
  assert.equal(incrementalPlan.waiting, undefined)
  assert.equal(incrementalPlan.projection.mode, "incremental")
  assert.equal(incrementalPlan.projection.batch_ids.length, 4)
  assert.equal(incrementalPlan.page_plan_complete, true)
  assert.equal(incrementalPlan.commit_ready, true)
  const competingWriter = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "wiki-writer-2" })
  assert.equal(competingWriter.waiting, true)
  assert.equal(competingWriter.projection.writer_busy, true)
  const leasedStatus = await f.core.status({ task_id: imported.task_id })
  assert.equal(leasedStatus.wiki_projection.page_plan_complete, true)
  assert.equal(leasedStatus.wiki_projection.page_plan_next_cursor, null)
  assert.deepEqual(leasedStatus.next_action, {
    tool: "llm_wiki_commit_pages",
    action_owner: "writer",
    delegate_to: "llm-wiki-writer",
    execution_mode: "bounded-plan-commit",
    arguments: {
      task_id: imported.task_id,
      writer_id: "wiki-writer-1",
      projection_id: incrementalPlan.projection.projection_id,
      based_on_wiki_revision: incrementalPlan.based_on_wiki_revision,
    },
  })

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
      content: `# Projected Entity\n\nProvisionalOnlyMarker\n\n${"Large provisional context. ".repeat(1_100)}`,
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

  const restartedPlan = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: incrementalPlan.projection.projection_id,
    cursor: 0,
    max_chars: 20_000,
  })
  assert.equal(restartedPlan.page_plan_complete, false)
  assert.equal(restartedPlan.commit_ready, false)
  assert.equal(restartedPlan.existing_pages.length, 0)
  assert.equal(restartedPlan.pagination.total_by_category.existing_pages, 1)
  await assert.rejects(
    () => f.core.commitPages({
      task_id: imported.task_id,
      writer_id: "wiki-writer-1",
      projection_id: incrementalPlan.projection.projection_id,
      based_on_wiki_revision: provisional.wiki_revision,
      idempotency_key: "premature-incremental-projection-ack-v1",
      projection_complete: false,
      patches: [],
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "PAGE_PLAN_INCOMPLETE"
      && error.details.expected_cursor === restartedPlan.next_cursor,
  )
  await assert.rejects(
    () => f.core.getPagePlanContext({
      task_id: imported.task_id,
      writer_id: "wiki-writer-1",
      projection_id: incrementalPlan.projection.projection_id,
      cursor: restartedPlan.next_cursor + 1,
      max_chars: 20_000,
    }),
    (error) => error instanceof LlmWikiError && error.code === "PAGE_PLAN_CURSOR_MISMATCH",
  )
  let continuationCursor = restartedPlan.next_cursor
  const pagePlanRevisionBeforeContinuation = JSON.parse(await readFile(taskPath, "utf8")).pagePlanRevision
  const recoveredExistingPages = []
  while (continuationCursor !== null) {
    const continuation = await f.core.getPagePlanContext({
      task_id: imported.task_id,
      writer_id: "wiki-writer-1",
      projection_id: incrementalPlan.projection.projection_id,
      cursor: continuationCursor,
      max_chars: 20_000,
    })
    recoveredExistingPages.push(...continuation.existing_pages)
    continuationCursor = continuation.next_cursor
  }
  assert.equal(JSON.parse(await readFile(taskPath, "utf8")).pagePlanRevision, pagePlanRevisionBeforeContinuation)
  assert.equal(recoveredExistingPages.length, 1)
  assert.equal(typeof recoveredExistingPages[0].file_hash, "string")
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
  const catchupReady = await f.core.status({ task_id: imported.task_id })
  assert.equal(catchupReady.status, "planning")
  assert.equal(catchupReady.wiki_projection.ready, true)
  assert.equal(catchupReady.wiki_projection.mode, "incremental")
  assert.equal(catchupReady.completion_gate.task_complete, false)
  assert.equal(catchupReady.completion_gate.may_report_completion, false)
  assert.equal(catchupReady.completion_gate.user_confirmation_required, false)
  assert.equal(catchupReady.completion_gate.automatic_continuation_required, true)
  assert.equal(catchupReady.completion_gate.finalize_ready, false)
  assert.equal(catchupReady.completion_gate.outstanding.unprojected_batches, 2)
  assert.equal(catchupReady.completion_gate.next_action.tool, "llm_wiki_get_page_plan_context")
  await assert.rejects(
    () => f.core.finalize({ task_id: imported.task_id }),
    (error) => error instanceof LlmWikiError
      && error.code === "FINALIZE_CATCHUP_REQUIRED"
      && error.details.unprojected_batch_count === 2
      && error.details.next_action.tool === "llm_wiki_get_page_plan_context"
      && error.details.completion_gate.user_confirmation_required === false,
  )

  const catchupPlan = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "wiki-writer-1", max_chars: 100_000 })
  assert.equal(catchupPlan.projection.mode, "incremental")
  assert.equal(catchupPlan.projection.batch_ids.length, 2)
  const caughtUp = await f.core.commitPages({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: catchupPlan.projection.projection_id,
    based_on_wiki_revision: catchupPlan.based_on_wiki_revision,
    idempotency_key: "catchup-projection-ack-v1",
    patches: [],
  })
  assert.equal(caughtUp.projection_complete, true)
  assert.equal(caughtUp.wiki_projection.mode, "final")
  assert.equal(caughtUp.wiki_projection.ready, true)
  assert.equal(caughtUp.next_action.tool, "llm_wiki_finalize")
  assert.equal(caughtUp.completion_gate.finalize_ready, true)
  assert.equal(caughtUp.completion_gate.automatic_continuation_required, true)
  await assert.rejects(
    () => f.core.finalize({ task_id: imported.task_id }),
    (error) => error instanceof LlmWikiError
      && error.code === "FINAL_PROJECTION_REQUIRED"
      && error.details.fast_finalization_audit.issues.some((issue) => issue.code === "MISSING_REQUIREMENT_SOURCE_REFS")
      && error.details.next_action.tool === "llm_wiki_get_page_plan_context"
      && error.details.completion_gate.automatic_continuation_required === true
      && error.details.completion_gate.user_confirmation_required === false,
  )
  const fallbackStatus = await f.core.status({ task_id: imported.task_id })
  assert.equal(fallbackStatus.wiki_projection.finalize_first, false)
  assert.equal(fallbackStatus.wiki_projection.fast_finalization_audit.eligible, false)
  assert.equal(fallbackStatus.next_action.tool, "llm_wiki_get_page_plan_context")

  const finalPlan = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "wiki-writer-1", max_chars: 100_000 })
  assert.equal(finalPlan.page_plan_complete, true)
  assert.equal(finalPlan.projection.mode, "final")
  assert.equal(finalPlan.projection.batch_ids.length, 6)
  assert.equal(finalPlan.finalization_hint.semantic_writer_required, true)
  assert.equal(finalPlan.finalization_hint.recommended_action, "final-semantic-reconciliation")
  assert.equal(finalPlan.page_requirements.length > 0, true)
  const finalPatchesByPath = new Map()
  for (const requirement of finalPlan.page_requirements) {
    const existing = finalPatchesByPath.get(requirement.patch_scaffold.path)
    if (existing) {
      existing.covers = [...new Set([...existing.covers, requirement.requirement_id])]
      existing.sourceRefs = [...new Set([...existing.sourceRefs, requirement.requirement_id])]
      continue
    }
    finalPatchesByPath.set(requirement.patch_scaffold.path, {
      ...requirement.patch_scaffold,
      content: `# ${requirement.title}\n\n## Overview\n\nA reconciled cross-batch summary for ${requirement.title}.\n`,
      summary: `A reconciled cross-batch summary for ${requirement.title}.`,
      tags: [requirement.page_kind],
    })
  }
  const finalPatches = [...finalPatchesByPath.values()]
  const stable = await f.core.commitPages({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: finalPlan.projection.projection_id,
    based_on_wiki_revision: finalPlan.based_on_wiki_revision,
    idempotency_key: "final-projection-pages-v1",
    patches: finalPatches,
  })
  assert.equal(stable.provisional, false)
  assert.deepEqual(stable.provisional_pages, [])
  assert.equal(stable.wiki_projection.final_completed, true)
  const finalized = await f.core.finalize({ task_id: imported.task_id })
  assert.equal(finalized.created_pages.includes("wiki/topics/projected-entity.md"), true)
  assert.equal(finalized.created_pages.includes("wiki/index.md"), true)
  assert.deepEqual(finalized.updated_pages, [])
  const completedStatus = await f.core.status({ task_id: imported.task_id })
  assert.equal(completedStatus.completion_gate.task_complete, true)
  assert.equal(completedStatus.completion_gate.may_report_completion, true)
  assert.equal(completedStatus.completion_gate.automatic_continuation_required, false)
  // A final drafter receives bounded context, so an existing page defaults to
  // merge and cannot silently delete unseen grounded provisional material.
  const completed = await f.core.retrieveContext({ task_id: imported.task_id, queries: ["reconciled cross-batch summary"] })
  assert.equal(completed.retrieval_phase, "knowledge-base-complete")
  assert.deepEqual(completed.available_channels, ["bm25", "wiki"])
  assert.deepEqual(completed.fallback_channels, ["feature_hash"])
  assert.equal(completed.hits.some((hit) => hit.path === "wiki/topics/projected-entity.md"), true)
  const provisionalAfterReplace = await f.core.retrieveContext({ task_id: imported.task_id, queries: ["ProvisionalOnlyMarker"] })
  assert.equal(provisionalAfterReplace.hits.some((hit) => hit.path === "wiki/topics/projected-entity.md"), true)

  // Simulate a process exit after the generation pointer was durable but
  // before task/result completion. A fresh Core instance must repair only the
  // task ledger and replay the exact published result.
  const recoveryTaskPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "task.json")
  const recoveryResultPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "result.json")
  const recoveryFinalizationPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "finalization.json")
  const taskRecord = JSON.parse(await readFile(recoveryTaskPath, "utf8"))
  const finalizationRecord = JSON.parse(await readFile(recoveryFinalizationPath, "utf8"))
  taskRecord.status = "finalizing"
  await writeFile(recoveryTaskPath, `${JSON.stringify(taskRecord)}\n`)
  await rm(recoveryResultPath, { force: true })
  await writeFile(recoveryFinalizationPath, `${JSON.stringify({ ...finalizationRecord, state: "published", result: finalized })}\n`)
  const recoveredCore = await LlmWikiCore.open(f.workspace)
  assert.equal((await recoveredCore.status({ task_id: imported.task_id })).status, "completed")
  assert.deepEqual(JSON.parse(await readFile(recoveryResultPath, "utf8")), finalized)
})

test("Finalize promotes audited incremental pages without running a second semantic projection", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id, worker_id: "fast-finalize-extractor" })
  const { analysis } = analysisFor(imported.task_id, batch)
  await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    worker_id: batch.worker_id,
    analysis,
    idempotency_key: "fast-finalize-analysis-v1",
  })

  const incrementalPlan = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    max_chars: 100_000,
  })
  assert.equal(incrementalPlan.projection.mode, "incremental")
  const patchesByPath = new Map()
  for (const requirement of incrementalPlan.page_requirements) {
    const existing = patchesByPath.get(requirement.patch_scaffold.path)
    if (existing) {
      existing.covers = [...new Set([...existing.covers, requirement.requirement_id])]
      existing.sourceRefs = [...new Set([...existing.sourceRefs, requirement.requirement_id])]
      continue
    }
    patchesByPath.set(requirement.patch_scaffold.path, {
      ...requirement.patch_scaffold,
      content: `# ${requirement.title}\n\nAuditedIncrementalMarker for ${requirement.title}.\n`,
      summary: `Incremental page for ${requirement.title}.`,
      tags: [requirement.page_kind],
    })
  }
  const incremental = await f.core.commitPages({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: incrementalPlan.projection.projection_id,
    based_on_wiki_revision: incrementalPlan.based_on_wiki_revision,
    projection_complete: true,
    patches: [...patchesByPath.values()],
    idempotency_key: "fast-finalize-incremental-pages-v1",
  })
  assert.equal(incremental.wiki_projection.mode, "final")
  assert.equal(incremental.next_action.tool, "llm_wiki_finalize")

  const finalized = await f.core.finalize({ task_id: imported.task_id })
  assert.equal(finalized.status, "completed")
  assert.equal(finalized.projection_finalization.mode, "fast-audit")
  assert.equal(finalized.projection_finalization.semantic_rewrite_performed, false)
  assert.equal(finalized.projection_finalization.fast_audit.eligible, true)
  const retrieved = await f.core.retrieveContext({ task_id: imported.task_id, queries: ["AuditedIncrementalMarker"] })
  assert.equal(retrieved.retrieval_phase, "knowledge-base-complete")
  assert.equal(retrieved.hits.some((hit) => hit.path.startsWith("wiki/")), true)
})

test("Wiki writer drains a backlog in bounded projections without resending unrelated page bodies", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const files = []
  for (let index = 0; index < 16; index += 1) {
    const file = path.join(f.incoming, `writer-backlog-${index}.md`)
    await writeFile(file, `# Writer Backlog ${index}\n\nBusiness Entity is the canonical business object.\n\n## Aggregate\n\nAn Aggregate groups related Business Entities. ${"Context ".repeat(105)}\n`)
    files.push({ path: file })
  }
  const imported = await f.core.importFiles({ files, options: { max_batch_chars: 1_000 } })
  assert.equal(imported.batch_count, 16)
  assert.equal(imported.wiki_projection.batch_limit, 8)
  assert.equal(imported.wiki_projection.writer_projection_quantum, 6)

  const refs = []
  for (let index = 0; index < 12; index += 1) {
    const batch = await f.core.getBatch({ task_id: imported.task_id, worker_id: `backlog-extractor-${index}` })
    const { sourceRef, analysis } = analysisFor(imported.task_id, batch)
    refs.push(sourceRef)
    const committed = await f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      worker_id: batch.worker_id,
      lease_token: batch.lease_token,
      analysis,
      idempotency_key: `writer-backlog-analysis-${index}`,
    })
    assert.equal(committed.accepted, true)
  }

  const concepts = path.join(f.workspace, "wiki", "concepts")
  await mkdir(concepts, { recursive: true })
  await writeFile(path.join(concepts, "unrelated-large.md"), `# Unrelated Large\n\n${"Unrelated content. ".repeat(2_000)}\n`)

  // Simulate an in-progress projection created by the older unbounded Writer.
  const taskPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "task.json")
  const persisted = JSON.parse(await readFile(taskPath, "utf8"))
  persisted.pageProjection.lease = {
    projectionId: "projection-legacy-writer-backlog",
    writerId: "wiki-writer-1",
    mode: "incremental",
    batchIds: [...persisted.completedBatchIds],
    analysisRevision: persisted.analysisRevision,
    leasedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    wikiRevision: null,
  }
  await writeFile(taskPath, JSON.stringify(persisted))

  const unfencedJoin = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "wiki-writer-1", max_chars: 40_000 })
  assert.equal(unfencedJoin.waiting, true)
  assert.equal(unfencedJoin.projection.writer_busy, true)
  const first = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: "projection-legacy-writer-backlog",
    max_chars: 40_000,
  })
  assert.equal(first.projection.mode, "incremental")
  assert.equal(first.projection.batch_ids.length, 8)
  assert.equal(first.projection.safely_repartitioned, true)
  assert.equal(first.projection.repartitioned_from_batch_count, 12)
  assert.equal(first.existing_pages.some((page) => page.path === "wiki/concepts/unrelated-large.md"), false)
  const catalogEntry = first.existing_page_catalog.find((page) => page.path === "wiki/concepts/unrelated-large.md")
  assert.equal(catalogEntry.content_included, false)
  assert.equal(catalogEntry.content, undefined)

  // An unrelated workspace change must not invalidate this projection or
  // force the Writer to recollect every page-plan cursor.
  await writeFile(path.join(concepts, "concurrent-unrelated.md"), "# Concurrent Unrelated\n\nWritten by another task.\n")
  const continued = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: first.projection.projection_id,
    cursor: first.next_cursor ?? 0,
    max_chars: 40_000,
  })
  assert.equal(continued.projection.projection_id, first.projection.projection_id)
  assert.equal(continued.based_on_wiki_revision, first.based_on_wiki_revision)
  assert.equal(continued.revision_scope, "target-pages")
  assert.equal(continued.concurrent_wiki_changes_detected, true)

  const committed = await f.core.commitPages({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: first.projection.projection_id,
    based_on_wiki_revision: first.based_on_wiki_revision,
    idempotency_key: "writer-backlog-pages-1",
    patches: [{
      patchId: "writer-backlog-page-1",
      path: "wiki/concepts/business-entity.md",
      operation: "create",
      title: "Business Entity",
      pageKind: "concept",
      content: "# Business Entity\n\nA canonical business object with Aggregate context.",
      covers: first.page_requirements.map((requirement) => requirement.requirement_id),
      sourceRefs: [refs[0]],
      rationale: "Materialize the bounded backlog projection.",
    }],
  })
  assert.equal(committed.unrelated_wiki_changes_accepted, true)
  assert.equal(committed.wiki_projection.ready, true)
  assert.equal(committed.wiki_projection.unprojected_batches, 4)
  assert.equal(committed.next_action.tool, "llm_wiki_get_page_plan_context")
  assert.equal(committed.next_action.action_owner, "coordinator")
  assert.equal(committed.writer_next_action, null)
  assert.equal(committed.coordinator_next_action.tool, "llm_wiki_get_page_plan_context")
  assert.equal(committed.next_action.arguments.view, "manifest")
  assert.equal(committed.coordinator_next_action.arguments.view, "manifest")

  const second = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "wiki-writer-1", max_chars: 40_000 })
  assert.equal(second.projection.batch_ids.length, 4)
  assert.equal(second.projection.batch_ids.some((batchId) => first.projection.batch_ids.includes(batchId)), false)
  const affected = second.existing_pages.find((page) => page.path === "wiki/concepts/business-entity.md")
  assert.equal(typeof affected.content, "string")
  assert.equal(second.existing_page_catalog.some((page) => page.path === "wiki/concepts/unrelated-large.md"), true)
})

test("current manifest projection reaches semantic reconciliation and final commits remain idempotent", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id, worker_id: "fast-projector-extractor" })
  const chunk = batch.chunks.find((item) => item.text.includes("Business Entity is the canonical business object."))
  const aggregateChunk = batch.chunks.find((item) => item.text.includes("An Aggregate groups related Business Entities."))
  const businessRef = {
    sourceId: chunk.sourceId,
    chunkId: chunk.chunkId,
    quote: "Business Entity is the canonical business object.",
    locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
  }
  const aggregateRef = {
    sourceId: aggregateChunk.sourceId,
    chunkId: aggregateChunk.chunkId,
    quote: "An Aggregate groups related Business Entities.",
    locator: { headingPath: aggregateChunk.headingPath, startOffset: aggregateChunk.startOffset, endOffset: aggregateChunk.endOffset },
  }
  await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    worker_id: batch.worker_id,
    lease_token: batch.lease_token,
    idempotency_key: "fast-projection-analysis-v1",
    analysis: {
      schemaVersion: 1,
      taskId: imported.task_id,
      batchId: batch.batch_id,
      sourceRefs: [businessRef, aggregateRef],
      entities: [{ localId: "entity-business", name: "Business Entity", properties: { id: "Stable identifier" }, sourceRefs: [0] }],
      concepts: [{ localId: "concept-aggregate", name: "Aggregate", sourceRefs: [1] }],
      claims: [{ localId: "claim-business", content: businessRef.quote, sourceRefs: [0] }],
      relations: [{
        localId: "relation-aggregate-business",
        content: aggregateRef.quote,
        sourceEntityLocalId: "concept-aggregate",
        targetEntityLocalId: "entity-business",
        sourceRefs: [1],
      }],
      contradictions: [],
      candidatePages: [],
      reviewItems: [],
      batchSummary: "Business Entity and Aggregate.",
      unresolvedQuestions: [],
    },
  })

  const before = await f.core.status({ task_id: imported.task_id })
  assert.equal(before.next_action.tool, "llm_wiki_get_page_plan_context")
  const projectedManifest = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    view: "manifest",
  })
  const projected = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: projectedManifest.projection.projection_id,
    cursor: 0,
    max_chars: 200_000,
  })
  assert.equal(projectedManifest.view, "manifest")
  assert.equal(projectedManifest.page_plan_complete, true)
  assert.equal(projectedManifest.parallel_drafting.partition_key, "page_requirement.patch_scaffold.path")
  assert.equal(projectedManifest.parallel_drafting.same_path_requirements_are_indivisible, true)
  assert.equal(projectedManifest.parallel_drafting.execution_mode, "coordinator-owned-parallel-drafters")
  assert.equal(projectedManifest.parallel_drafting.fallback_mode, "serial-writer-only")
  assert.equal(projectedManifest.parallel_drafting.writer_launch_policy, "after-staged-drafter-receipt")
  assert.equal(projectedManifest.parallel_drafting.writer_normal_mode, "staged-receipt-commit-only")
  assert.equal(projectedManifest.parallel_drafting.sole_committer, "wiki-writer-1")
  assert.equal(projected.projection.mode, "incremental")
  assert.equal(projected.page_plan_complete, true)
  const incrementalPatches = projected.page_requirements.map((requirement) => ({
    ...requirement.patch_scaffold,
    content: `# ${requirement.title}\n\n## Overview\n\nSemantically reconciled page for ${requirement.title}.\n`,
    summary: `Semantically reconciled page for ${requirement.title}.`,
    tags: [requirement.page_kind],
  }))
  await assert.rejects(
    () => f.core.commitPages({
      task_id: imported.task_id,
      writer_id: "wiki-writer-1",
      projection_id: projected.projection.projection_id,
      based_on_wiki_revision: projected.based_on_wiki_revision,
      idempotency_key: "parallel-draft-duplicate-path-v1",
      patches: [incrementalPatches[0], { ...incrementalPatches[0], patchId: `${incrementalPatches[0].patchId}-duplicate` }],
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "INVALID_PAGE_PATCH"
      && error.details?.validation_errors?.some((item) => /Duplicate page path/.test(item.message)),
  )
  const duplicateCoverage = {
    ...incrementalPatches[0],
    patchId: `${incrementalPatches[0].patchId}-duplicate-coverage`,
    path: incrementalPatches[0].path.replace(/\.md$/, "-duplicate-coverage.md"),
    operation: "create",
    title: `${incrementalPatches[0].title} duplicate`,
  }
  delete duplicateCoverage.expectedFileHash
  await assert.rejects(
    () => f.core.commitPages({
      task_id: imported.task_id,
      writer_id: "wiki-writer-1",
      projection_id: projected.projection.projection_id,
      based_on_wiki_revision: projected.based_on_wiki_revision,
      idempotency_key: "parallel-draft-duplicate-coverage-v1",
      patches: [...incrementalPatches, duplicateCoverage],
    }),
    (error) => error instanceof LlmWikiError && error.code === "DUPLICATE_PAGE_COVERAGE",
  )
  const incremental = await f.core.commitPages({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: projected.projection.projection_id,
    based_on_wiki_revision: projected.based_on_wiki_revision,
    idempotency_key: "manifest-semantic-projection-v1",
    patches: incrementalPatches,
  })
  assert.equal(incremental.wiki_projection.final_completed, false)
  const finalPlan = await f.core.getPagePlanContext({ task_id: imported.task_id, writer_id: "wiki-writer-1", max_chars: 40_000 })
  assert.equal(finalPlan.projection.mode, "final")
  const finalRequest = {
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: finalPlan.projection.projection_id,
    based_on_wiki_revision: finalPlan.based_on_wiki_revision,
    idempotency_key: "manifest-semantic-final-v1",
    patches: finalPlan.page_requirements.map((requirement) => ({
      ...requirement.patch_scaffold,
      content: `# ${requirement.title}\n\n## Overview\n\nSemantically reconciled page for ${requirement.title}.\n`,
      summary: `Semantically reconciled page for ${requirement.title}.`,
      tags: [requirement.page_kind],
    })),
  }
  const reconciled = await f.core.commitPages(finalRequest)
  assert.equal(reconciled.wiki_projection.final_completed, true)
  assert.equal(reconciled.next_action.tool, "llm_wiki_finalize")
  const replayed = await f.core.commitPages(finalRequest)
  assert.equal(replayed.idempotent_replay, true)
  assert.equal(replayed.transaction_id, reconciled.transaction_id)

  const businessPage = await readFile(path.join(f.workspace, "wiki", "entities", "business-entity.md"), "utf8")
  const aggregatePage = await readFile(path.join(f.workspace, "wiki", "concepts", "aggregate.md"), "utf8")
  assert.match(businessPage, /Semantically reconciled page for Business Entity/)
  assert.match(businessPage, /aggregate/)
  assert.match(aggregatePage, /Semantically reconciled page for Aggregate/)
  assert.match(aggregatePage, /business-entity/)
})

test("current manifest Writer keeps projections bounded to the batch window", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const files = []
  for (let index = 0; index < 12; index += 1) {
    const file = path.join(f.incoming, `fast-backlog-${index}.md`)
    await writeFile(file, `# Fast backlog ${index}\n\nBusiness Entity ${index} is documented here. ${"Context ".repeat(105)}\n`)
    files.push({ path: file })
  }
  const imported = await f.core.importFiles({ files, options: { max_batch_chars: 1_000 } })
  assert.equal(imported.batch_count >= 12, true)
  let analyzed = 0
  while (true) {
    const batch = await f.core.getBatch({ task_id: imported.task_id, worker_id: "fast-backlog-extractor" })
    if (batch.completed) break
    const sourceRef = batch.chunks[0].source_ref_templates[0]
    await f.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      worker_id: batch.worker_id,
      lease_token: batch.lease_token,
      idempotency_key: `fast-backlog-analysis-${batch.batch_id}`,
      analysis: {
        schemaVersion: 1,
        taskId: imported.task_id,
        batchId: batch.batch_id,
        sourceRefs: [sourceRef],
        entities: [{ localId: `entity-${analyzed}`, name: `Business Entity ${analyzed}`, sourceRefs: [0] }],
        concepts: [], claims: [], relations: [], contradictions: [], candidatePages: [], reviewItems: [],
        batchSummary: `Fast backlog ${analyzed}.`,
        unresolvedQuestions: [],
      },
    })
    analyzed += 1
  }
  assert.equal(analyzed > 8, true)

  const projected = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    view: "manifest",
  })
  assert.equal(projected.view, "manifest")
  assert.equal(projected.projection.mode, "incremental")
  assert.equal(projected.projection.batch_ids.length <= 8, true)
  assert.equal(projected.draft_manifest.page_count > 0, true)
})

test("knowledge-base deletion requires confirmation, blocks active tasks, and preserves configuration by scope", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  await assert.rejects(
    () => f.core.deleteKnowledgeBase({ scope: "wiki", confirmation: "DELETE" }),
    (error) => error instanceof LlmWikiError && error.code === "DELETE_CONFIRMATION_REQUIRED",
  )
  await assert.rejects(
    () => f.core.deleteKnowledgeBase({ scope: "wiki", confirmation: "DELETE KNOWLEDGE BASE" }),
    (error) => error instanceof LlmWikiError && error.code === "KNOWLEDGE_BASE_BUSY",
  )
  await f.core.abort({ task_id: imported.task_id, reason: "Deletion test" })
  const taskPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "task.json")
  const failedTask = JSON.parse(await readFile(taskPath, "utf8"))
  failedTask.status = "failed"
  await writeFile(taskPath, JSON.stringify(failedTask))
  await mkdir(path.join(f.workspace, "wiki", "topics"), { recursive: true })
  await writeFile(path.join(f.workspace, "wiki", "topics", "manual.md"), "# Manual\n\nKeep this only until deletion.\n")

  const wikiOnly = await f.core.deleteKnowledgeBase({ scope: "wiki", confirmation: "DELETE KNOWLEDGE BASE" })
  assert.equal(wikiOnly.accepted, true)
  assert.equal(wikiOnly.scope, "wiki")
  assert.equal((await readdir(path.join(f.workspace, "wiki"))).length, 0)
  assert.equal((await readdir(path.join(f.workspace, ".llm-wiki", "sources", "objects"))).length > 0, true)
  await access(path.join(f.workspace, ".llm-wiki", "config.json"))

  const everything = await f.core.deleteKnowledgeBase({ scope: "knowledge_base", confirmation: "DELETE KNOWLEDGE BASE" })
  assert.equal(everything.accepted, true)
  assert.equal((await readdir(path.join(f.workspace, ".llm-wiki", "sources", "objects"))).length, 0)
  assert.equal((await readdir(path.join(f.workspace, ".llm-wiki", "tasks"))).length, 0)
  await access(path.join(f.workspace, ".llm-wiki", "config.json"))
  await access(path.join(f.workspace, "llm-wiki.schema.md"))
})

test("workspace publication ownership serializes task publishers until finalize", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const secondSource = path.join(f.incoming, "second-product.md")
  await writeFile(secondSource, "# Second Product\n\nSecond Product is a distinct canonical object.\n")

  const [firstTask, secondTask] = await Promise.all([
    f.core.importFiles({ files: [{ path: f.source }] }),
    f.core.importFiles({ files: [{ path: secondSource }] }),
  ])
  const firstRefPromise = analyzeAll(f.core, firstTask)
  const secondRefPromise = (async () => {
    const batch = await f.core.getBatch({ task_id: secondTask.task_id })
    const chunk = batch.chunks.find((item) => item.text.includes("Second Product is a distinct canonical object."))
    const sourceRef = {
      sourceId: chunk.sourceId,
      chunkId: chunk.chunkId,
      quote: "Second Product is a distinct canonical object.",
      locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
    }
    await f.core.commitAnalysis({
      task_id: secondTask.task_id,
      batch_id: batch.batch_id,
      idempotency_key: "concurrent-second-analysis",
      analysis: {
        schemaVersion: 1,
        taskId: secondTask.task_id,
        batchId: batch.batch_id,
        sourceRefs: [sourceRef],
        entities: [{ localId: "entity-second-product", name: "Second Product", sourceRefs: [0] }],
        concepts: [], claims: [], relations: [], contradictions: [], candidatePages: [], reviewItems: [],
        batchSummary: "Defines Second Product.",
        unresolvedQuestions: [],
      },
    })
    return sourceRef
  })()
  const [firstRef, secondRef] = await Promise.all([firstRefPromise, secondRefPromise])
  const [firstPlan, secondPlan] = await Promise.all([
    f.core.getPagePlanContext({ task_id: firstTask.task_id }),
    f.core.getPagePlanContext({ task_id: secondTask.task_id }),
  ])
  assert.equal(firstPlan.based_on_wiki_revision, secondPlan.based_on_wiki_revision)

  const firstResult = await f.core.commitPages({
    task_id: firstTask.task_id,
    based_on_wiki_revision: firstPlan.based_on_wiki_revision,
    idempotency_key: "concurrent-writer-first-page",
    patches: [{
      patchId: "concurrent-first",
      path: "wiki/topics/concurrent-first.md",
      operation: "create",
      title: "Concurrent First",
      pageKind: "topic",
      content: "# Concurrent First\n\nFirst task content.",
      covers: firstPlan.page_requirements.map((requirement) => requirement.requirement_id),
      sourceRefs: [firstRef],
      rationale: "Exercise workspace transaction serialization.",
    }],
  })
  await assert.rejects(
    () => f.core.commitPages({
      task_id: secondTask.task_id,
      based_on_wiki_revision: secondPlan.based_on_wiki_revision,
      idempotency_key: "concurrent-writer-second-page",
      patches: [{
        patchId: "concurrent-second",
        path: "wiki/topics/concurrent-second.md",
        operation: "create",
        title: "Concurrent Second",
        pageKind: "topic",
        content: "# Concurrent Second\n\nSecond task content.",
        covers: secondPlan.page_requirements.map((requirement) => requirement.requirement_id),
        sourceRefs: [secondRef],
        rationale: "Exercise workspace transaction serialization.",
      }],
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "WIKI_PUBLICATION_BUSY"
      && error.details.owner_task_id === firstTask.task_id,
  )

  assert.equal(firstResult.accepted, true)
  const blocked = await f.core.status({ task_id: secondTask.task_id })
  assert.equal(blocked.wiki_publication.state, "waiting")
  assert.equal(blocked.wiki_projection.blocked_by_publication, true)
  assert.equal(blocked.wiki_projection.blocked_by_task_id, firstTask.task_id)
  await f.core.finalize({ task_id: firstTask.task_id })

  const refreshedSecondPlan = await f.core.getPagePlanContext({ task_id: secondTask.task_id })
  const secondResult = await f.core.commitPages({
    task_id: secondTask.task_id,
    based_on_wiki_revision: refreshedSecondPlan.based_on_wiki_revision,
    idempotency_key: "concurrent-writer-second-page-after-owner-finalize",
    patches: [{
      patchId: "concurrent-second",
      path: "wiki/topics/concurrent-second.md",
      operation: "create",
      title: "Concurrent Second",
      pageKind: "topic",
      content: "# Concurrent Second\n\nSecond task content.",
      covers: refreshedSecondPlan.page_requirements.map((requirement) => requirement.requirement_id),
      sourceRefs: [secondRef],
      rationale: "Publish after the previous task finalizes.",
    }],
  })
  assert.equal(secondResult.accepted, true)
  assert.match(await readFile(path.join(f.workspace, "wiki", "topics", "concurrent-first.md"), "utf8"), /First task content/)
  assert.match(await readFile(path.join(f.workspace, "wiki", "topics", "concurrent-second.md"), "utf8"), /Second task content/)
})

test("blocked projection commits discard stale pending manifests before retry", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const waiterSource = path.join(f.incoming, "waiter.md")
  await writeFile(waiterSource, "# Waiting Product\n\nWaiting Product is a distinct canonical object.\n")
  const owner = await f.core.importFiles({ files: [{ path: f.source }] })
  const waiter = await f.core.importFiles({ files: [{ path: waiterSource }] })
  const ownerRef = await analyzeAll(f.core, owner)
  const waiterBatch = await f.core.getBatch({ task_id: waiter.task_id })
  const waiterChunk = waiterBatch.chunks[0]
  const waiterRef = waiterChunk.source_ref_templates[0]
  await f.core.commitAnalysis({
    task_id: waiter.task_id,
    batch_id: waiterBatch.batch_id,
    idempotency_key: "waiting-projection-analysis",
    analysis: {
      schemaVersion: 1,
      taskId: waiter.task_id,
      batchId: waiterBatch.batch_id,
      sourceRefs: [waiterRef],
      entities: [{ localId: "waiting-product", name: "Waiting Product", sourceRefs: [0] }],
      concepts: [], claims: [], relations: [], contradictions: [], candidatePages: [], reviewItems: [],
      batchSummary: "Defines Waiting Product.",
      unresolvedQuestions: [],
    },
  })

  const ownerPlan = await f.core.getPagePlanContext({ task_id: owner.task_id })
  await f.core.commitPages({
    task_id: owner.task_id,
    based_on_wiki_revision: ownerPlan.based_on_wiki_revision,
    idempotency_key: "waiting-projection-owner-publish",
    patches: [{
      patchId: "waiting-projection-owner-page",
      path: "wiki/topics/waiting-owner.md",
      operation: "create",
      title: "Waiting Owner",
      pageKind: "topic",
      content: "# Waiting Owner\n\nOwner content.",
      covers: ownerPlan.page_requirements.map((requirement) => requirement.requirement_id),
      sourceRefs: [ownerRef],
      rationale: "Hold durable publication ownership.",
    }],
  })

  const manifest = await f.core.getPagePlanContext({ task_id: waiter.task_id, writer_id: "wiki-writer-1", view: "manifest" })
  const blockedStatus = await f.core.status({ task_id: waiter.task_id })
  assert.equal(blockedStatus.wiki_publication.state, "waiting")
  assert.equal(blockedStatus.next_action.tool, "llm_wiki_status")
  assert.equal(blockedStatus.next_action.arguments.task_id, owner.task_id)
  assert.equal(blockedStatus.subagent_recovery.blocked_by_publication, true)
  assert.equal(blockedStatus.subagent_recovery.roles.drafter.desired_live_invocations, 0)
  assert.equal(blockedStatus.subagent_recovery.roles.writer.desired_live_invocations, 0)
  const shardAction = manifest.draft_manifest.draft_actions[0].arguments
  let shard = await f.core.getPagePlanContext(shardAction)
  const requirements = [...shard.page_requirements]
  while (shard.next_cursor !== null) {
    shard = await f.core.getPagePlanContext({ ...shardAction, cursor: shard.next_cursor })
    requirements.push(...shard.page_requirements)
  }
  const patchesByPath = new Map()
  for (const requirement of requirements) {
    const existing = patchesByPath.get(requirement.patch_scaffold.path)
    if (existing) {
      existing.covers = [...new Set([...existing.covers, ...requirement.patch_scaffold.covers])]
      existing.sourceRefs = [...new Set([...existing.sourceRefs, ...requirement.patch_scaffold.sourceRefs])]
      continue
    }
    patchesByPath.set(requirement.patch_scaffold.path, {
      ...requirement.patch_scaffold,
      content: `# ${requirement.title}\n\nWaiting projection content.`,
      summary: "Waiting projection content.",
      tags: [requirement.page_kind],
    })
  }
  await assert.rejects(
    () => f.core.commitPages({
      task_id: waiter.task_id,
      writer_id: "wiki-writer-1",
      projection_id: manifest.projection.projection_id,
      based_on_wiki_revision: manifest.based_on_wiki_revision,
      idempotency_key: "waiting-projection-blocked-wave",
      projection_complete: false,
      draft_shard_ids: [shardAction.shard_id],
      patches: [...patchesByPath.values()],
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "WIKI_PUBLICATION_BUSY"
      && error.details.projection_plan_invalidated === true,
  )

  const waiterTaskPath = path.join(f.workspace, ".llm-wiki", "tasks", waiter.task_id, "task.json")
  const waiterTask = JSON.parse(await readFile(waiterTaskPath, "utf8"))
  assert.equal(waiterTask.pageProjection.lease.pagePlanTraversal, null)
  assert.equal(waiterTask.pageProjection.lease.planInvalidationReason, "WIKI_PUBLICATION_BUSY")
  assert.deepEqual(waiterTask.pageProjection.lease.stagedDraftReceipts, {})
  await assert.rejects(() => access(path.join(path.dirname(waiterTaskPath), "page-plan.json")))
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
  assert.equal(second.reused_task, true)
  assert.equal(second.task_id, first.task_id)
  assert.equal(second.completion_gate.task_complete, false)
  assert.equal(second.completion_gate.automatic_continuation_required, true)
  assert.equal(second.subagent_recovery.roles.extractor.desired_live_invocations, 1)
  const listed = await f.core.listTasks({ status: ["prepared"] })
  assert.equal(listed.tasks.length, 1)
  await assert.rejects(
    () => f.core.importFiles({ files: [{ path: duplicatePath }], options: { force_reanalyze: true } }),
    (error) => error instanceof LlmWikiError
      && error.code === "EQUIVALENT_TASK_ACTIVE"
      && error.details.existing_task_id === first.task_id,
  )
  const aborted = await f.core.abort({ task_id: first.task_id, reason: "test cancellation" })
  assert.equal(aborted.status, "cancelled")
  const cancelledStatus = await f.core.status({ task_id: first.task_id })
  assert.equal(cancelledStatus.status, "cancelled")
  assert.equal(cancelledStatus.completion_gate.task_complete, false)
  assert.equal(cancelledStatus.completion_gate.task_terminal, true)
  assert.equal(cancelledStatus.completion_gate.automatic_continuation_required, false)
  assert.equal(cancelledStatus.completion_gate.partial_progress_is_terminal, true)
  assert.equal(cancelledStatus.parallel_extraction.enabled, false)
  assert.equal(cancelledStatus.subagent_recovery.roles.extractor.desired_live_invocations, 0)
  assert.equal(cancelledStatus.subagent_recovery.roles.drafter.desired_live_invocations, 0)
  assert.equal(cancelledStatus.subagent_recovery.roles.writer.desired_live_invocations, 0)
  const forced = await f.core.importFiles({ files: [{ path: duplicatePath }], options: { force_reanalyze: true } })
  assert.equal(forced.reused_task, false)
  assert.notEqual(forced.task_id, first.task_id)
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
  for (const chunk of repaired.chunks) {
    assert.equal(chunk.endOffset - chunk.startOffset, chunk.text.length)
  }
  for (let index = 1; index < repaired.chunks.length; index += 1) {
    assert.equal(repaired.chunks[index].startOffset >= repaired.chunks[index - 1].endOffset, true)
  }
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

test("server-side page manifests keep 50-plus-page projections in durable bounded shards", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const source = path.join(f.incoming, "many-pages.md")
  const statements = Array.from({ length: 52 }, (_, index) => `Entity ${index} is a supported business object.`)
  await writeFile(source, `# Many pages\n\n${statements.join("\n\n")}\n`)
  const imported = await f.core.importFiles({ files: [{ path: source }] })
  const batch = await f.core.getBatch({ task_id: imported.task_id, worker_id: "manifest-extractor" })
  const chunk = batch.chunks.find((item) => item.text.includes(statements[0]))
  const sourceRefs = statements.map((quote) => ({
    sourceId: chunk.sourceId,
    chunkId: chunk.chunkId,
    quote,
    locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
  }))
  await f.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    worker_id: batch.worker_id,
    idempotency_key: "many-page-analysis-v1",
    analysis: {
      schemaVersion: 1,
      taskId: imported.task_id,
      batchId: batch.batch_id,
      sourceRefs,
      entities: statements.map((content, index) => ({ localId: `entity-${index}`, name: `Entity ${index}`, content, sourceRefs: [index] })),
      concepts: [], claims: [], relations: [], contradictions: [], candidatePages: [], reviewItems: [],
      batchSummary: "Fifty-two supported entities.", unresolvedQuestions: [],
    },
  })

  await assert.rejects(
    () => f.core.getPagePlanContext({ task_id: imported.task_id, view: "manifest" }),
    (error) => error instanceof LlmWikiError && error.code === "INVALID_INPUT",
  )

  const manifest = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    view: "manifest",
    cursor: 0,
    max_chars: 40_000,
  })
  assert.equal(manifest.view, "manifest")
  assert.equal(manifest.page_commit_limits.max_patches_per_call, 50)
  assert.equal(manifest.draft_manifest.page_count, 52)
  assert.equal(manifest.draft_manifest.shard_count, 9)
  assert.equal(manifest.draft_manifest.returned_shard_count, 4)
  assert.equal(manifest.draft_manifest.complete_manifest_persisted_server_side, true)
  assert.equal(manifest.draft_manifest.shards.every((shard) => shard.page_count <= 6), true)
  assert.equal(manifest.page_requirements, undefined)
  await assert.rejects(
    () => f.core.getPagePlanContext({
      ...manifest.draft_manifest.draft_actions[0].arguments,
      cursor: 1,
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "PAGE_PLAN_CURSOR_MISMATCH"
      && error.details?.expected_cursor === 0,
  )
  await assert.rejects(
    () => f.core.commitPages({
      task_id: imported.task_id,
      writer_id: "wiki-writer-1",
      projection_id: manifest.projection.projection_id,
      based_on_wiki_revision: manifest.based_on_wiki_revision,
      projection_complete: false,
      draft_shard_ids: ["draft-0001"],
      patches: [],
      idempotency_key: "many-page-unread-shard-v1",
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "PAGE_DRAFT_SHARD_NOT_READY"
      && error.details?.next_draft_shard?.shard_id === "draft-0001",
  )
  await assert.rejects(
    () => f.core.commitPages({
      task_id: imported.task_id,
      writer_id: "wiki-writer-1",
      projection_id: manifest.projection.projection_id,
      based_on_wiki_revision: manifest.based_on_wiki_revision,
      projection_complete: true,
      patches: [],
      idempotency_key: "many-page-premature-final-v1",
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "PAGE_DRAFT_SHARDS_INCOMPLETE"
      && error.details?.next_draft_shard?.shard_id === "draft-0001",
  )

  let action = manifest.next_action
  let revision = manifest.based_on_wiki_revision
  let committedPages = 0
  const visitedShards = []
  while (action.tool === "llm_wiki_get_page_plan_context") {
    const shard = await f.core.getPagePlanContext(action.arguments)
    if (shard.view === "manifest") {
      action = shard.next_action
      continue
    }
    assert.equal(shard.view, "draft-shard")
    assert.equal(shard.draft_shard_complete, true)
    assert.equal(shard.page_requirements.length <= 6, true)
    visitedShards.push(shard.shard.shard_id)
    await assert.rejects(
      () => f.core.commitPages({
        task_id: imported.task_id,
        writer_id: "wiki-writer-1",
        projection_id: manifest.projection.projection_id,
        based_on_wiki_revision: revision,
        projection_complete: false,
        draft_shard_ids: [shard.shard.shard_id],
        patches: [],
        idempotency_key: `many-page-empty-shard-${shard.shard.shard_id}`,
      }),
      (error) => error instanceof LlmWikiError
        && error.code === "INVALID_PAGE_PATCH"
        && error.details?.atomic_commit_applied === false,
    )
    const afterEmpty = await f.core.status({ task_id: imported.task_id })
    assert.equal(afterEmpty.wiki_projection.committed_draft_shards, visitedShards.length - 1)
    if (shard.page_requirements.length > 1) {
      const incompletePatch = {
        ...shard.page_requirements[0].patch_scaffold,
        content: `# ${shard.page_requirements[0].title}\n\nIncomplete shard.\n`,
        summary: "Incomplete shard.",
      }
      await assert.rejects(
        () => f.core.commitPages({
          task_id: imported.task_id,
          writer_id: "wiki-writer-1",
          projection_id: manifest.projection.projection_id,
          based_on_wiki_revision: revision,
          projection_complete: false,
          draft_shard_ids: [shard.shard.shard_id],
          patches: [incompletePatch],
          idempotency_key: `many-page-incomplete-shard-${shard.shard.shard_id}`,
        }),
        (error) => error instanceof LlmWikiError
          && error.code === "INCOMPLETE_PAGE_COVERAGE"
          && error.details?.shard_id === shard.shard.shard_id,
      )
      const afterIncomplete = await f.core.status({ task_id: imported.task_id })
      assert.equal(afterIncomplete.wiki_projection.committed_draft_shards, visitedShards.length - 1)
    }
    const patches = shard.page_requirements.map((requirement) => ({
      ...requirement.patch_scaffold,
      content: `# ${requirement.title}\n\n## Summary\n\n${requirement.title} is a supported business object.\n`,
      summary: `${requirement.title} is a supported business object.`,
    }))
    const committed = await f.core.commitPages({
      task_id: imported.task_id,
      writer_id: "wiki-writer-1",
      projection_id: manifest.projection.projection_id,
      based_on_wiki_revision: revision,
      projection_complete: false,
      draft_shard_ids: [shard.shard.shard_id],
      patches,
      idempotency_key: `many-page-shard-${shard.shard.shard_id}`,
    })
    revision = committed.wiki_revision
    committedPages += patches.length
    action = committed.next_action
  }
  assert.equal(committedPages, 52)
  assert.equal(new Set(visitedShards).size, 9)
  assert.equal(action.tool, "llm_wiki_commit_pages")
  assert.deepEqual(action.arguments.patches, [])
  const completed = await f.core.commitPages({
    ...action.arguments,
    based_on_wiki_revision: revision,
    idempotency_key: "many-page-final-ack-v1",
  })
  assert.equal(completed.projection_complete, true)
})

test("page drafters stage receipt-only shards and the Writer commits them server-side", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  await analyzeAll(f.core, imported)
  const manifest = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    view: "manifest",
    cursor: 0,
    max_chars: 40_000,
  })
  let action = manifest.draft_manifest.draft_actions[0]
  assert.equal(action.action_owner, "coordinator")
  assert.equal(action.delegate_to, "llm-wiki-page-drafter")
  assert.equal(typeof action.arguments.draft_claim_token, "string")
  const expiredClaimToken = action.arguments.draft_claim_token
  const claimTaskPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "task.json")
  const claimTask = JSON.parse(await readFile(claimTaskPath, "utf8"))
  claimTask.pageProjection.lease.draftShardClaims[action.arguments.shard_id].expiresAt = new Date(0).toISOString()
  await writeFile(claimTaskPath, JSON.stringify(claimTask))
  await assert.rejects(
    () => f.core.getPagePlanContext(action.arguments),
    (error) => error instanceof LlmWikiError && error.code === "DRAFT_SHARD_CLAIM_FENCED",
  )
  const refreshedManifest = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: manifest.projection.projection_id,
    view: "manifest",
    cursor: 0,
    max_chars: 40_000,
  })
  action = refreshedManifest.draft_manifest.draft_actions[0]
  assert.notEqual(action.arguments.draft_claim_token, expiredClaimToken)
  const shard = await f.core.getPagePlanContext(action.arguments)
  assert.equal(shard.draft_shard_complete, true)
  assert.equal(shard.context_retrieval_complete, true)
  assert.equal(shard.commit_ready, false)
  assert.equal(shard.staged, false)
  assert.equal(shard.writer_commit_ready, false)
  assert.equal(shard.next_action.tool, "llm_wiki_stage_page_drafts")
  assert.equal(shard.next_action.action_owner, "drafter")
  assert.equal(shard.next_action.delegate_to, "llm-wiki-page-drafter")
  assert.equal(shard.serial_writer_fallback_action.tool, "llm_wiki_commit_pages")
  assert.equal(shard.serial_writer_fallback_action.execution_mode, "explicit-serial-writer-fallback-only")
  assert.equal(shard.draft_context_limits.max_response_chars, 40_000)
  assert.equal(shard.draft_context_limits.full_existing_pages_remain_server_side, true)
  const retrievedOnlyStatus = await f.core.status({ task_id: imported.task_id })
  assert.equal(retrievedOnlyStatus.wiki_projection.retrieved_not_staged_draft_shards, 1)
  assert.equal(retrievedOnlyStatus.wiki_projection.staged_uncommitted_draft_shards, 0)
  assert.equal(retrievedOnlyStatus.wiki_projection.claimed_draft_shards, 1)
  assert.equal(retrievedOnlyStatus.wiki_projection.draft_claims_are_live_drafters, false)
  assert.equal(retrievedOnlyStatus.wiki_projection.in_progress_semantics, "persisted-projection-lease-not-live-agent")
  assert.equal(retrievedOnlyStatus.wiki_projection.process_liveness_known, false)
  assert.equal(retrievedOnlyStatus.wiki_projection.projection_lease_is_live_writer, false)
  assert.equal(retrievedOnlyStatus.wiki_projection.pending_shards_are_live_drafters, false)
  assert.equal(retrievedOnlyStatus.subagent_recovery.roles.extractor.desired_live_invocations, 0)
  assert.equal(retrievedOnlyStatus.subagent_recovery.roles.drafter.work_remaining, true)
  assert.equal(retrievedOnlyStatus.subagent_recovery.roles.drafter.desired_live_invocations, 1)
  assert.equal(retrievedOnlyStatus.subagent_recovery.roles.drafter.retrieved_not_staged_shards, 1)
  assert.equal(retrievedOnlyStatus.subagent_recovery.roles.drafter.persisted_claims, 1)
  assert.equal(retrievedOnlyStatus.subagent_recovery.roles.drafter.claims_are_live_invocations, false)
  assert.equal(retrievedOnlyStatus.subagent_recovery.roles.drafter.pending_shards_are_live_invocations, false)
  assert.equal(retrievedOnlyStatus.subagent_recovery.roles.drafter.reconcile_action.arguments.view, "manifest")
  assert.equal(retrievedOnlyStatus.subagent_recovery.roles.writer.desired_live_invocations, 0)
  const patches = shard.page_requirements.map((requirement) => ({
    ...requirement.patch_scaffold,
    content: `# ${requirement.title}\n\n## Summary\n\nA server-staged semantic draft.\n`,
    summary: "A server-staged semantic draft.",
  }))
  const staged = await f.core.stagePageDrafts({
    ...shard.next_action.arguments,
    patches,
    idempotency_key: "stage-page-draft-v1",
  })
  assert.equal(staged.accepted, true)
  assert.equal(staged.staged, true)
  assert.equal(staged.writer_commit_ready, true)
  assert.equal(staged.main_agent_payload, "receipt-only")
  assert.equal(staged.patches, undefined)
  assert.equal(staged.next_action.action_owner, "writer")
  assert.equal(staged.next_action.delegate_to, "llm-wiki-writer")
  assert.deepEqual(staged.next_action.arguments.draft_receipts, [{ shard_id: shard.shard.shard_id, draft_hash: staged.draft_hash }])
  const stagedTaskPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "task.json")
  const persistedAfterStage = JSON.parse(await readFile(stagedTaskPath, "utf8"))
  delete persistedAfterStage.pageProjection.lease.stagedDraftReceipts
  await writeFile(stagedTaskPath, JSON.stringify(persistedAfterStage))
  const recoveredStatus = await f.core.status({ task_id: imported.task_id })
  assert.deepEqual(recoveredStatus.projection_recovery.recovered_staged_draft_receipts, [shard.shard.shard_id])
  assert.equal(recoveredStatus.wiki_projection.retrieved_not_staged_draft_shards, 0)
  assert.equal(recoveredStatus.wiki_projection.staged_uncommitted_draft_shards, 1)
  assert.equal(recoveredStatus.wiki_projection.claimed_draft_shards, 0)
  assert.deepEqual(recoveredStatus.wiki_projection.recoverable_staged_draft_receipts, [
    { shard_id: shard.shard.shard_id, draft_hash: staged.draft_hash },
  ])
  assert.equal(recoveredStatus.next_action.tool, "llm_wiki_get_staged_page_drafts")
  assert.equal(recoveredStatus.next_action.action_owner, "writer")
  assert.equal(recoveredStatus.subagent_recovery.roles.drafter.desired_live_invocations, 0)
  assert.equal(recoveredStatus.subagent_recovery.roles.writer.work_ready, true)
  assert.equal(recoveredStatus.subagent_recovery.roles.writer.desired_live_invocations, 1)
  assert.equal(recoveredStatus.subagent_recovery.roles.writer.projection_lease_is_live_invocation, false)
  assert.deepEqual(recoveredStatus.subagent_recovery.roles.writer.resume_action, recoveredStatus.next_action)
  const stagedDraftDir = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "page-drafts")
  const stagedDraftPath = path.join(stagedDraftDir, (await readdir(stagedDraftDir))[0])
  const persistedDraft = JSON.parse(await readFile(stagedDraftPath, "utf8"))
  const tamperedDraft = {
    ...persistedDraft,
    patches: persistedDraft.patches.map((patch, index) => (
      index === 0 ? { ...patch, content: `${patch.content}\nTampered after staging.\n` } : patch
    )),
  }
  await writeFile(stagedDraftPath, JSON.stringify(tamperedDraft))
  await assert.rejects(
    () => f.core.getStagedPageDrafts(staged.next_action.arguments),
    (error) => error instanceof LlmWikiError && error.code === "STAGED_DRAFT_HASH_MISMATCH",
  )
  await writeFile(stagedDraftPath, JSON.stringify(persistedDraft))
  await assert.rejects(
    () => f.core.getStagedPageDrafts({
      task_id: imported.task_id,
      writer_id: "wiki-writer-1",
      projection_id: manifest.projection.projection_id,
    }),
    (error) => error instanceof LlmWikiError && error.code === "INVALID_INPUT",
  )
  await assert.rejects(
    () => f.core.getStagedPageDrafts({
      ...staged.next_action.arguments,
      draft_receipts: [{ shard_id: shard.shard.shard_id, draft_hash: "0".repeat(64) }],
    }),
    (error) => error instanceof LlmWikiError && error.code === "STAGED_DRAFT_HASH_MISMATCH",
  )
  const changedPatches = patches.map((patch) => ({ ...patch, content: `${patch.content}\nChanged after receipt.\n` }))
  await assert.rejects(
    () => f.core.stagePageDrafts({
      ...shard.next_action.arguments,
      patches: changedPatches,
      idempotency_key: "stage-page-draft-v2",
    }),
    (error) => error instanceof LlmWikiError && error.code === "STAGED_DRAFT_EXISTS",
  )
  const stagedStatus = await f.core.getStagedPageDrafts(staged.next_action.arguments)
  assert.equal(stagedStatus.ready_for_server_commit, true)
  assert.equal(stagedStatus.staged[0].draft_hash, staged.draft_hash)
  assert.equal(stagedStatus.next_action.action_owner, "writer")
  await assert.rejects(
    () => f.core.commitPages({
      ...stagedStatus.next_action.arguments,
      staged_draft_receipts: [{ shard_id: shard.shard.shard_id, draft_hash: "0".repeat(64) }],
      idempotency_key: "commit-staged-page-draft-wrong-hash",
    }),
    (error) => error instanceof LlmWikiError && error.code === "STAGED_DRAFT_HASH_MISMATCH",
  )
  const committed = await f.core.commitPages({
    ...stagedStatus.next_action.arguments,
    idempotency_key: "commit-staged-page-draft-v1",
  })
  assert.equal(committed.accepted, true)
  assert.deepEqual(committed.committed_draft_receipts, [{ shard_id: shard.shard.shard_id, draft_hash: staged.draft_hash }])
  assert.deepEqual(committed.committed_draft_receipts, [{ shard_id: shard.shard.shard_id, draft_hash: staged.draft_hash }])
  assert.equal(committed.main_agent_payload, "receipt-only")
  assert.equal(committed.next_action.action_owner, committed.projection.pending_draft_shards > 0 ? "coordinator" : "writer")
  assert.equal(committed.writer_next_action, null)
  const after = await f.core.getStagedPageDrafts(staged.next_action.arguments)
  assert.deepEqual(after.missing_shard_ids, [shard.shard.shard_id])
})

test("status repairs a legacy empty-committed draft shard and resumes it", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  await analyzeAll(f.core, imported)
  const manifest = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    view: "manifest",
    cursor: 0,
    max_chars: 40_000,
  })
  const shardId = manifest.draft_manifest.shards[0].shard_id
  const taskPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "task.json")
  const persisted = JSON.parse(await readFile(taskPath, "utf8"))
  persisted.pageProjection.lease.committedDraftShardIds = [shardId]
  persisted.pageProjection.lease.retrievedDraftShardIds = []
  persisted.pageProjection.lease.nextDraftShardId = null
  delete persisted.pageProjection.lease.coverageAuditAt
  delete persisted.pageProjection.lease.coverageAuditWikiRevision
  await writeFile(taskPath, JSON.stringify(persisted))

  const recovered = await f.core.status({ task_id: imported.task_id })
  assert.deepEqual(recovered.projection_recovery.repaired_shard_ids, [shardId])
  assert.equal(recovered.wiki_projection.committed_draft_shards, 0)
  assert.equal(recovered.wiki_projection.next_draft_shard_id, shardId)
  assert.equal(recovered.next_action.tool, "llm_wiki_get_page_plan_context")
  assert.equal(recovered.next_action.arguments.view, "manifest")

  const recoveredManifest = await f.core.getPagePlanContext(recovered.next_action.arguments)
  const shard = await f.core.getPagePlanContext(recoveredManifest.draft_manifest.draft_actions[0].arguments)
  assert.equal(shard.draft_shard_complete, true)
  const patches = shard.page_requirements.map((requirement) => ({
    ...requirement.patch_scaffold,
    content: `# ${requirement.title}\n\nRecovered semantic page.\n`,
    summary: "Recovered semantic page.",
  }))
  const committed = await f.core.commitPages({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    projection_id: manifest.projection.projection_id,
    based_on_wiki_revision: manifest.based_on_wiki_revision,
    projection_complete: false,
    draft_shard_ids: [shardId],
    patches,
    idempotency_key: "recovered-empty-shard-v1",
  })
  assert.equal(committed.accepted, true)
  assert.equal(committed.projection.committed_draft_shards, 1)
})

test("draft-shard cursor replay preserves the original max_chars boundary", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  await analyzeAll(f.core, imported)
  await mkdir(path.join(f.workspace, "wiki", "concepts"), { recursive: true })
  await writeFile(path.join(f.workspace, "wiki", "concepts", "business-entity.md"), `# Business Entity\n\n${"Existing body. ".repeat(2_000)}\n`)
  await writeFile(path.join(f.workspace, "wiki", "concepts", "aggregate.md"), `# Aggregate\n\n${"Existing body. ".repeat(2_000)}\n`)
  const manifest = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    view: "manifest",
    cursor: 0,
    max_chars: 40_000,
  })
  const action = manifest.draft_manifest.draft_actions[0].arguments
  const first = await f.core.getPagePlanContext({ ...action, max_chars: 1_000 })
  assert.notEqual(first.next_cursor, null)
  const replay = await f.core.getPagePlanContext({ ...action, max_chars: 40_000 })
  assert.equal(replay.next_cursor, first.next_cursor)
  assert.deepEqual(replay.pagination, first.pagination)
  let cursor = replay.next_cursor
  while (cursor !== null) {
    const page = await f.core.getPagePlanContext({
      ...action,
      cursor,
      max_chars: 40_000,
    })
    cursor = page.next_cursor
  }
  const taskPath = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "task.json")
  const persisted = JSON.parse(await readFile(taskPath, "utf8"))
  const reads = persisted.pageProjection.lease.draftShardCursorReads[manifest.draft_manifest.shards[0].shard_id]
  assert.equal(reads["0"].max_chars, 1_000)
})

test("aborting a task removes uncommitted server-side page drafts", async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const imported = await f.core.importFiles({ files: [{ path: f.source }] })
  await analyzeAll(f.core, imported)
  const manifest = await f.core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    view: "manifest",
    cursor: 0,
    max_chars: 40_000,
  })
  const shard = await f.core.getPagePlanContext(manifest.draft_manifest.draft_actions[0].arguments)
  const patches = shard.page_requirements.map((requirement) => ({
    ...requirement.patch_scaffold,
    content: `# ${requirement.title}\n\nStaged then cancelled.\n`,
    summary: "Staged then cancelled.",
  }))
  await f.core.stagePageDrafts({
    ...shard.next_action.arguments,
    patches,
    idempotency_key: "stage-page-draft-abort-v1",
  })
  const draftDir = path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "page-drafts")
  assert.equal((await readdir(draftDir)).length, 1)
  const aborted = await f.core.abort({ task_id: imported.task_id, reason: "cancel staged draft" })
  assert.equal(aborted.status, "cancelled")
  await assert.rejects(() => access(draftDir))
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
  const invalidQuote = (suffix) => ({ ...sourceRef, quote: `This quote is not present in the source: ${suffix}` })
  await assert.rejects(
    () => f.core.commitPages({
      task_id: partial.task_id,
      based_on_wiki_revision: plan.based_on_wiki_revision,
      idempotency_key: "multi-patch-source-ref-validation",
      patches: [
        { patchId: "invalid-quote-1", path: "wiki/concepts/invalid-quote-1.md", operation: "create", title: "Invalid Quote One", pageKind: "concept", content: "# Invalid Quote One", sourceRefs: [invalidQuote("one")], rationale: "test" },
        { patchId: "invalid-quote-2", path: "wiki/concepts/invalid-quote-2.md", operation: "create", title: "Invalid Quote Two", pageKind: "concept", content: "# Invalid Quote Two", sourceRefs: [invalidQuote("two")], rationale: "test" },
      ],
    }),
    (error) => error instanceof LlmWikiError
      && error.code === "INVALID_SOURCE_REF"
      && error.details.atomic_commit_applied === false
      && error.details.retry_scope === "entire_rejected_patch_set"
      && error.details.validation_errors.length === 2
      && error.details.validation_errors[0].patch_id === "invalid-quote-1"
      && error.details.validation_errors[1].patch_id === "invalid-quote-2",
  )
  assert.equal(await access(path.join(f.workspace, "wiki", "concepts", "invalid-quote-1.md")).then(() => true, () => false), false)
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
