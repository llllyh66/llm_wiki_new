import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const textResult = (result) => JSON.parse(result.content[0].text)

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
  assert.equal(listed.tools.length, 11)
  assert.equal(listed.tools.some((tool) => tool.name === "llm_wiki_import_files"), true)
  assert.equal(listed.tools.some((tool) => tool.name === "llm_wiki_projects"), false)

  const handledError = await client.callTool({ name: "llm_wiki_status", arguments: { task_id: "invalid" } })
  assert.equal(handledError.isError, true)
  assert.equal(handledError.structuredContent, undefined)
  assert.equal(textResult(handledError).error.code, "TASK_NOT_FOUND")
  assert.equal((await client.listTools()).tools.length, 11)

  const oversizedInput = await client.callTool({
    name: "llm_wiki_lint",
    arguments: { padding: "x".repeat(12 * 1024 * 1024 + 1) },
  })
  assert.equal(oversizedInput.isError, true)
  assert.equal(oversizedInput.structuredContent, undefined)
  assert.equal(textResult(oversizedInput).error.code, "MCP_INPUT_TOO_LARGE")
  assert.equal((await client.listTools()).tools.length, 11)

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
    arguments: { task_id: taskId, batch_id: batch.structuredContent.batch_id, queries: ["Business Entity"] },
  })
  assert.equal(retrieval.isError, undefined)

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
    assert.equal((await client.listTools()).tools.length, 11)
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
  const plan = await client.callTool({ name: "llm_wiki_get_page_plan_context", arguments: { task_id: taskId, cursor: 0 } })
  assert.equal(plan.structuredContent.next_cursor, null)
  const pages = await client.callTool({
    name: "llm_wiki_commit_pages",
    arguments: {
      task_id: taskId,
      based_on_wiki_revision: plan.structuredContent.based_on_wiki_revision,
      idempotency_key: "stdio-pages-v1",
      patches: [{
        patchId: "business-v1",
        path: "wiki/concepts/business-entity.md",
        operation: "create",
        title: "Business Entity",
        pageKind: "concept",
        content: "# Business Entity\n\nA canonical business object.",
        sourceRefs: [sourceRef],
        rationale: "The source defines this concept.",
      }],
    },
  })
  assert.equal(pages.isError, undefined)
  const finalized = await client.callTool({ name: "llm_wiki_finalize", arguments: { task_id: taskId } })
  assert.equal(finalized.structuredContent.status, "completed")
  const status = await client.callTool({ name: "llm_wiki_status", arguments: { task_id: taskId } })
  assert.equal(status.structuredContent.status, "completed")
  const tasks = await client.callTool({ name: "llm_wiki_list_tasks", arguments: {} })
  assert.equal(tasks.structuredContent.tasks.length, 1)
  const abort = await client.callTool({ name: "llm_wiki_abort", arguments: { task_id: taskId } })
  assert.equal(abort.structuredContent.changed, false)
  assert.equal((await client.listTools()).tools.length, 11)
})
