import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const textResult = (result) => JSON.parse(result.content[0].text)

test("built MCP server remains usable across idle protocol heartbeats", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-stdio-idle-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--workspace", workspace],
    stderr: "pipe",
    env: {
      // Production remains five minutes; the short test interval proves that
      // repeated server-initiated ping/pong traffic does not poison STDIO.
      LLM_WIKI_MCP_KEEPALIVE_MS: "1000",
      LLM_WIKI_MCP_KEEPALIVE_TIMEOUT_MS: "500",
    },
  })
  let stderr = ""
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk) })
  const client = new Client({ name: "llm-wiki-idle-heartbeat-test", version: "1.0.0" })
  t.after(() => transport.close().catch(() => {}))
  await client.connect(transport)

  await new Promise((resolve) => setTimeout(resolve, 2_400))
  const listed = await client.listTools()
  assert.equal(listed.tools.length, 17)
  assert.match(stderr, /"event":"keepalive".*"status":"ok"/)
  assert.doesNotMatch(stderr, /"event":"fatal"/)
})

test("an unhandled background rejection is logged without closing the shared STDIO", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-stdio-unhandled-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--workspace", workspace],
    stderr: "pipe",
    env: { LLM_WIKI_MCP_TEST_UNHANDLED_REJECTION: "1" },
  })
  let stderr = ""
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk) })
  const client = new Client({ name: "llm-wiki-unhandled-rejection-test", version: "1.0.0" })
  t.after(() => transport.close().catch(() => {}))
  await client.connect(transport)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal((await client.listTools()).tools.length, 17)
  assert.match(stderr, /"event":"unhandled-rejection"/)
  assert.doesNotMatch(stderr, /"event":"shutdown-requested".*"reason":"unhandled-rejection"/)
})

test("built MCP server survives errors and completes the full workflow over one STDIO connection", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-stdio-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--workspace", workspace],
    stderr: "pipe",
  })
  const client = new Client({ name: "llm-wiki-contract-test", version: "1.0.0" })
  t.after(() => transport.close().catch(() => {}))
  await client.connect(transport)
  const listed = await client.listTools()
  assert.equal(listed.tools.length, 17)
  assert.equal(listed.tools.some((tool) => tool.name === "llm_wiki_import_files"), true)
  assert.equal(listed.tools.some((tool) => tool.name === "llm_wiki_projects"), false)

  const handledError = await client.callTool({ name: "llm_wiki_status", arguments: { task_id: "invalid" } })
  assert.equal(handledError.isError, undefined)
  assert.equal(handledError.structuredContent.error.code, "TASK_NOT_FOUND")
  assert.equal(handledError.structuredContent.mcp_connection_usable, true)
  assert.equal((await client.listTools()).tools.length, 17)

  const oversizedInput = await client.callTool({
    name: "llm_wiki_lint",
    arguments: { padding: "x".repeat(12 * 1024 * 1024 + 1) },
  })
  assert.equal(oversizedInput.isError, undefined)
  assert.equal(oversizedInput.structuredContent.error.code, "MCP_INPUT_TOO_LARGE")
  assert.equal(oversizedInput.structuredContent.mcp_connection_usable, true)
  assert.equal((await client.listTools()).tools.length, 17)

  const failingCalls = [
    { name: "llm_wiki_import_files", arguments: {} },
    { name: "llm_wiki_get_batch", arguments: { task_id: "invalid" } },
    { name: "llm_wiki_get_domain_schema", arguments: { task_id: "invalid" } },
    { name: "llm_wiki_retrieve_context", arguments: { task_id: "invalid", batch_id: "batch-0001", queries: ["x"] } },
    { name: "llm_wiki_commit_analysis", arguments: { task_id: "invalid", batch_id: "batch-0001", analysis: {}, idempotency_key: "invalid-analysis-v1" } },
    { name: "llm_wiki_get_page_plan_context", arguments: { task_id: "invalid" } },
    { name: "llm_wiki_stage_page_drafts", arguments: { task_id: "invalid" } },
    { name: "llm_wiki_get_staged_page_drafts", arguments: { task_id: "invalid" } },
    { name: "llm_wiki_apply_projection", arguments: { task_id: "invalid" } },
    { name: "llm_wiki_commit_pages", arguments: { task_id: "invalid", patches: [], based_on_wiki_revision: "0".repeat(64), idempotency_key: "invalid-pages-v1" } },
    { name: "llm_wiki_update_pages", arguments: { task_id: "invalid", action: "inspect", targets: [{ path: "wiki/concepts/example.md" }] } },
    { name: "llm_wiki_finalize", arguments: { task_id: "invalid" } },
    { name: "llm_wiki_abort", arguments: { task_id: "invalid" } },
    { name: "llm_wiki_delete_knowledge_base", arguments: { scope: "wiki", confirmation: "DELETE" } },
    { name: "llm_wiki_lint", arguments: { task_id: "invalid" } },
    { name: "llm_wiki_unknown_tool", arguments: {} },
  ]
  for (let round = 0; round < 3; round += 1) {
    for (const call of failingCalls) {
      const failed = await client.callTool(call)
      assert.equal(failed.isError, undefined, `${call.name} round ${round}`)
      assert.equal(failed.structuredContent.ok, false, `${call.name} round ${round}`)
      assert.equal(failed.structuredContent.mcp_connection_usable, true, `${call.name} round ${round}`)
      assert.equal((await client.listTools()).tools.length, 17, `${call.name} round ${round}`)
    }
  }

  const lint = await client.callTool({ name: "llm_wiki_lint", arguments: {} })
  assert.equal(lint.isError, undefined)
  assert.equal(lint.structuredContent.errors, 0)

  const source = path.join(workspace, "product.md")
  await writeFile(source, "# Product\n\nBusiness Entity is the canonical business object.\n")
  const imported = await client.callTool({
    name: "llm_wiki_import_files",
    arguments: { files: [{ path: source }] },
  })
  assert.equal(imported.isError, undefined)
  const taskId = imported.structuredContent.task_id
  const batch = await client.callTool({ name: "llm_wiki_get_batch", arguments: { task_id: taskId } })
  const chunk = batch.structuredContent.chunks[0]
  const sourceRef = {
    sourceId: chunk.sourceId,
    chunkId: chunk.chunkId,
    quote: "Business Entity is the canonical business object.",
    locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
  }
  const retrieval = await client.callTool({
    name: "llm_wiki_retrieve_context",
    arguments: { task_id: taskId, queries: ["Business Entity"] },
  })
  assert.equal(retrieval.isError, undefined)
  assert.equal(retrieval.structuredContent.retrieval_phase, "building")
  assert.deepEqual(retrieval.structuredContent.available_channels, ["bm25", "embedding"])

  // Reproduce the failure sequence seen in real Agent runs: a dense analysis
  // with many validation errors, a malformed retry, and a bad SourceRef. None
  // of these handled tool errors may close or poison the STDIO connection.
  const invalidAnalyses = [
    {
      schemaVersion: 1,
      taskId,
      batchId: batch.structuredContent.batch_id,
      sourceRefs: [sourceRef],
      entities: Array.from({ length: 60 }, (_, index) => ({ localId: `missing-ref-${index}`, name: `Entity ${index}` })),
      concepts: [],
      claims: [],
      relations: [],
      contradictions: [],
      candidatePages: [],
      reviewItems: [],
      batchSummary: "Invalid dense analysis.",
      unresolvedQuestions: [],
    },
    "analysis is not an object",
    {
      schemaVersion: 1,
      taskId,
      batchId: batch.structuredContent.batch_id,
      sourceRefs: [{ ...sourceRef, chunkId: "chunk-does-not-exist" }],
      entities: [],
      concepts: [],
      claims: [],
      relations: [],
      contradictions: [],
      candidatePages: [],
      reviewItems: [],
      batchSummary: "Invalid SourceRef.",
      unresolvedQuestions: [],
    },
    {
      schemaVersion: 1,
      taskId,
      batchId: batch.structuredContent.batch_id,
      sourceRefs: [{ ...sourceRef, quote: "Product" }],
      entities: [],
      concepts: [],
      claims: Array.from({ length: 47 }, (_, index) => ({
        localId: `kqi-claim-${index}`,
        name: `DNS metric ${index}`,
        content: `DNS query latency metric ${index} measures network response time.`,
        sourceRefs: [0],
      })),
      relations: [],
      contradictions: [],
      candidatePages: [],
      reviewItems: [],
      batchSummary: "Invalid KQI-style title-only grounding.",
      unresolvedQuestions: [],
    },
  ]
  for (const [index, invalidAnalysis] of invalidAnalyses.entries()) {
    const invalid = await client.callTool({
      name: "llm_wiki_commit_analysis",
      arguments: {
        task_id: taskId,
        batch_id: batch.structuredContent.batch_id,
        analysis: invalidAnalysis,
        idempotency_key: `stdio-invalid-analysis-${index}`,
      },
    })
    assert.equal(invalid.isError, undefined)
    assert.equal(invalid.structuredContent.accepted, false)
    assert.equal(invalid.structuredContent.rejected, true)
    assert.match(invalid.structuredContent.error.code, /^INVALID_(ANALYSIS|SOURCE_REF)$/)
    if (index === 0) {
      assert.equal(invalid.structuredContent.error.details.validation_error_count, 60)
      assert.equal(invalid.structuredContent.validation_errors.length, 51)
    }
    if (index === 3) {
      assert.equal(invalid.structuredContent.error.details.quality_gate, "source-ref-grounding-v1")
      assert.equal(invalid.structuredContent.error.details.validation_error_count, 48)
    }
    assert.equal((await client.listTools()).tools.length, 17)
    const liveStatus = await client.callTool({ name: "llm_wiki_status", arguments: { task_id: taskId } })
    assert.equal(liveStatus.isError, undefined)
  }

  const analysis = {
    schemaVersion: 1,
    taskId,
    batchId: batch.structuredContent.batch_id,
    sourceRefs: [sourceRef],
    entities: [{ localId: "entity-business", name: "Business Entity", sourceRefs: [0] }],
    concepts: [],
    claims: [{ localId: "claim-business", text: "Business Entity is canonical.", sourceRefs: [0] }],
    relations: [],
    contradictions: [],
    candidatePages: [{ localId: "page-business", title: "Business Entity", sourceRefs: [0] }],
    reviewItems: [],
    batchSummary: "Defines Business Entity.",
    unresolvedQuestions: [],
  }
  const analyzed = await client.callTool({
    name: "llm_wiki_commit_analysis",
    arguments: { task_id: taskId, batch_id: batch.structuredContent.batch_id, analysis, idempotency_key: "stdio-analysis-v1" },
  })
  assert.equal(analyzed.isError, undefined)
  assert.equal(analyzed.structuredContent.normalized_source_ref_indexes, 3)
  assert.equal(analyzed.structuredContent.next_action.tool, "llm_wiki_get_page_plan_context")
  const projected = await client.callTool({
    name: "llm_wiki_apply_projection",
    arguments: { task_id: taskId, writer_id: "stdio-wiki-writer", max_projections: 6 },
  })
  assert.equal(projected.isError, undefined)
  assert.equal(projected.structuredContent.automated, false)
  assert.equal(projected.structuredContent.writer_mode, "legacy-semantic")
  assert.equal(projected.structuredContent.semantic_writer_required, true)
  assert.equal(projected.structuredContent.next_action.tool, "llm_wiki_get_page_plan_context")
  assert.equal(projected.structuredContent.page_commit_limits.max_patches_per_call, 50)
  const shardCall = await client.callTool({
    name: projected.structuredContent.next_action.tool,
    arguments: projected.structuredContent.next_action.arguments,
  })
  const finalPlan = shardCall.structuredContent
  assert.equal(finalPlan.draft_shard_complete, true)
  const finalPatches = finalPlan.page_requirements.map((requirement) => ({
    ...requirement.patch_scaffold,
    content: `# ${requirement.title}\n\n## Overview\n\nA semantically reconciled grounded page.\n`,
    summary: "A semantically reconciled grounded page.",
    tags: [requirement.page_kind],
  }))
  const semanticCommit = await client.callTool({
    name: "llm_wiki_commit_pages",
    arguments: {
      task_id: taskId,
      writer_id: "stdio-wiki-writer",
      projection_id: finalPlan.projection.projection_id,
      based_on_wiki_revision: finalPlan.based_on_wiki_revision,
      projection_complete: false,
      draft_shard_ids: [finalPlan.shard.shard_id],
      patches: finalPatches,
      idempotency_key: "stdio-final-semantic-v1",
    },
  })
  assert.equal(semanticCommit.structuredContent.wiki_projection.final_completed, false)
  const incrementalAck = await client.callTool({
    name: semanticCommit.structuredContent.next_action.tool,
    arguments: {
      ...semanticCommit.structuredContent.next_action.arguments,
      idempotency_key: "stdio-incremental-ack-v1",
    },
  })
  assert.equal(incrementalAck.structuredContent.projection_complete, true)
  const finalReconcileCall = await client.callTool({
    name: "llm_wiki_get_page_plan_context",
    arguments: { task_id: taskId, writer_id: "stdio-wiki-writer", view: "manifest", cursor: 0, max_chars: 40_000 },
  })
  assert.equal(finalReconcileCall.structuredContent.projection.mode, "final")
  const finalShardCall = await client.callTool({
    name: finalReconcileCall.structuredContent.next_action.tool,
    arguments: finalReconcileCall.structuredContent.next_action.arguments,
  })
  const finalReconcile = finalShardCall.structuredContent
  const finalWave = await client.callTool({
    name: "llm_wiki_commit_pages",
    arguments: {
      task_id: taskId,
      writer_id: "stdio-wiki-writer",
      projection_id: finalReconcile.projection.projection_id,
      based_on_wiki_revision: finalReconcile.based_on_wiki_revision,
      projection_complete: false,
      draft_shard_ids: [finalReconcile.shard.shard_id],
      patches: finalReconcile.page_requirements.map((requirement) => ({
        ...requirement.patch_scaffold,
        content: `# ${requirement.title}\n\n## Overview\n\nA semantically reconciled grounded page.\n`,
        summary: "A semantically reconciled grounded page.",
        tags: [requirement.page_kind],
      })),
      idempotency_key: "stdio-final-reconcile-v1",
    },
  })
  const finalCommit = await client.callTool({
    name: finalWave.structuredContent.next_action.tool,
    arguments: {
      ...finalWave.structuredContent.next_action.arguments,
      idempotency_key: "stdio-final-ack-v1",
    },
  })
  assert.equal(finalCommit.structuredContent.wiki_projection.final_completed, true)
  const finalized = await client.callTool({ name: "llm_wiki_finalize", arguments: { task_id: taskId } })
  assert.equal(finalized.structuredContent.status, "completed")
  const status = await client.callTool({ name: "llm_wiki_status", arguments: { task_id: taskId } })
  assert.equal(status.structuredContent.status, "completed")
  const tasks = await client.callTool({ name: "llm_wiki_list_tasks", arguments: {} })
  assert.equal(tasks.structuredContent.tasks.length, 1)
  const abort = await client.callTool({ name: "llm_wiki_abort", arguments: { task_id: taskId } })
  assert.equal(abort.structuredContent.changed, false)

  // A domain-schema rejection is also a recoverable business result and must
  // not disconnect the same long-lived MCP process.
  const domainSchema = path.join(workspace, "domain-schema")
  await mkdir(path.join(domainSchema, "customer"), { recursive: true })
  await writeFile(path.join(domainSchema, "all_domains.json"), JSON.stringify({ domains: [{ key: "customer", name: "客户域" }] }))
  await writeFile(path.join(domainSchema, "customer", "customer_domain.json"), JSON.stringify({ abes: [{ key: "customer_management", name: "客户管理" }] }))
  await writeFile(path.join(domainSchema, "customer", "customer_management.json"), JSON.stringify({ businessEntities: [{ id: "individual_customer", name: "个人客户" }] }))
  const domainSource = path.join(workspace, "domain.md")
  await writeFile(domainSource, "# Domain\n\n客户 C-001 名为张三。\n")
  const domainImported = await client.callTool({
    name: "llm_wiki_import_files",
    arguments: { files: [{ path: domainSource }], options: { domain_schema_path: domainSchema } },
  })
  const domainTaskId = domainImported.structuredContent.task_id
  const domainBatch = await client.callTool({ name: "llm_wiki_get_batch", arguments: { task_id: domainTaskId } })
  assert.equal(domainBatch.structuredContent.analysis_scaffold.schemaVersion, 1)
  assert.equal(domainBatch.structuredContent.analysis_scaffold.taskId, domainTaskId)
  assert.equal(domainBatch.structuredContent.analysis_scaffold.batchId, domainBatch.structuredContent.batch_id)
  assert.deepEqual(domainBatch.structuredContent.analysis_scaffold.reviewItems, [])
  assert.equal(domainBatch.structuredContent.workspace_context.domain_schema.mode, "progressive-directory-v2")
  assert.equal(domainBatch.structuredContent.workspace_context.domain_schema_auto_selection, undefined)
  const selectedDomains = await client.callTool({
    name: "llm_wiki_get_domain_schema",
    arguments: { task_id: domainTaskId, level: "domains" },
  })
  assert.equal(selectedDomains.isError, undefined)
  assert.deepEqual(selectedDomains.structuredContent.content, { domains: [{ key: "customer", name: "客户域" }] })
  const selectedAbe = await client.callTool({
    name: "llm_wiki_get_domain_schema",
    arguments: { task_id: domainTaskId, level: "abe", domain_folder: "customer", abe_file: "customer_management.json" },
  })
  assert.deepEqual(selectedAbe.structuredContent.content, { businessEntities: [{ id: "individual_customer", name: "个人客户" }] })
  const domainChunk = domainBatch.structuredContent.chunks[0]
  const domainRef = {
    sourceId: domainChunk.sourceId,
    chunkId: domainChunk.chunkId,
    quote: "客户 C-001 名为张三。",
    locator: { headingPath: domainChunk.headingPath, startOffset: domainChunk.startOffset, endOffset: domainChunk.endOffset },
  }
  const domainRejected = await client.callTool({
    name: "llm_wiki_commit_analysis",
    arguments: {
      task_id: domainTaskId,
      batch_id: domainBatch.structuredContent.batch_id,
      idempotency_key: "stdio-domain-rejection-v2",
      analysis: {
        schemaVersion: 1,
        taskId: domainTaskId,
        batchId: domainBatch.structuredContent.batch_id,
        sourceRefs: [domainRef],
        entities: [{ localId: "subject-1", name: "张三", sourceRefs: [0] }],
        concepts: [], claims: [], relations: [], contradictions: [], candidatePages: [], reviewItems: [],
        batchSummary: "Invalid domain analysis.",
        unresolvedQuestions: [],
      },
    },
  })
  assert.equal(domainRejected.isError, undefined)
  assert.equal(domainRejected.structuredContent.accepted, false)
  assert.equal(domainRejected.structuredContent.error.code, "INVALID_DOMAIN_ANALYSIS")
  assert.equal(domainRejected.structuredContent.validation_errors.length > 0, true)
  assert.equal((await client.listTools()).tools.length, 17)
  const domainStatus = await client.callTool({ name: "llm_wiki_status", arguments: { task_id: domainTaskId } })
  assert.equal(domainStatus.structuredContent.status, "prepared")
  assert.equal((await client.listTools()).tools.length, 17)

  const largeSource = path.join(workspace, "large.md")
  const largeRows = Array.from({ length: 4_000 }, (_, index) => `| metric-${index} | ${"value ".repeat(8)}${index} |`)
  await writeFile(largeSource, `# Large\n\n| Name | Value |\n| --- | --- |\n${largeRows.join("\n")}\n\n\`\`\`text\n${"x".repeat(500_000)}\n\`\`\`\n`)
  const largeImported = await client.callTool({
    name: "llm_wiki_import_files",
    arguments: { files: [{ path: largeSource }], options: { max_batch_chars: 12_000 } },
  })
  assert.equal(largeImported.isError, undefined)
  const largeBatch = await client.callTool({
    name: "llm_wiki_get_batch",
    arguments: { task_id: largeImported.structuredContent.task_id, worker_id: "large-worker-1", max_chars: 1_000 },
  })
  assert.equal(largeBatch.isError, undefined)
  assert.equal(largeBatch.structuredContent.batch_limits.complete, true)
  assert.equal(largeBatch.structuredContent.batch_limits.char_count <= 6_000, true)
  assert.equal(largeBatch.structuredContent.batch_limits.payload_bytes <= 24 * 1024, true)
  assert.equal(largeBatch.structuredContent.batch_limits.agent_payload_ceiling_bytes, 24 * 1024)
  assert.equal(largeBatch.structuredContent.batch_limits.complete_response_bytes < 40 * 1024, true)
  assert.equal(Buffer.byteLength(largeBatch.content[0].text) < 40 * 1024, true)
  assert.equal(largeBatch.structuredContent.chunks.every((chunk) => chunk.text.length <= 3_000), true)
  assert.equal(Math.max(...largeBatch.content[0].text.split("\n").map((line) => line.length)) <= 4_000, true)
  const secondLargeBatch = await client.callTool({
    name: "llm_wiki_get_batch",
    arguments: { task_id: largeImported.structuredContent.task_id, worker_id: "large-worker-2" },
  })
  assert.notEqual(secondLargeBatch.structuredContent.batch_id, largeBatch.structuredContent.batch_id)
  assert.equal((await client.listTools()).tools.length, 17)
  const largeStatus = await client.callTool({ name: "llm_wiki_status", arguments: { task_id: largeImported.structuredContent.task_id } })
  assert.equal(largeStatus.structuredContent.status, "prepared")
  assert.equal(largeStatus.structuredContent.leased_batches, 2)
})
