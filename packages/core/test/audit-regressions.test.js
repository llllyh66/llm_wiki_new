import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { LlmWikiCore, LlmWikiError } from "../src/index.js"

async function fixture(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  const workspace = path.join(root, "workspace")
  const incoming = path.join(root, "incoming")
  await Promise.all([mkdir(workspace), mkdir(incoming)])
  return { root, workspace, incoming, core: await LlmWikiCore.open(workspace) }
}

test("progressive import registers first and publishes each parsed source to BM25", async (t) => {
  const f = await fixture("llm-wiki-progressive-")
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const files = []
  for (let index = 0; index < 16; index += 1) {
    const source = path.join(f.incoming, `progressive-${index}.md`)
    const marker = index === 0 ? "FIRST_SOURCE_READY_MARKER" : `progressive-marker-${index}`
    await writeFile(source, `# Progressive ${index}\n\n${marker}\n\n${`context-${index} `.repeat(8_000)}\n`)
    files.push({ path: source })
  }

  const imported = await f.core.importFiles({
    files,
    options: { progressive_import: true, host_capabilities: { max_total_agents: 4, coordinator_slots: 1 } },
  })
  assert.equal(imported.status, "importing")
  assert.equal(imported.batch_count, 0)
  assert.equal(imported.pending_sources.length, files.length)

  let intermediateRetrieval = null
  let finalStatus = null
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const status = await f.core.status({ task_id: imported.task_id })
    if (!intermediateRetrieval && status.retrieval_readiness?.sources?.bm25_indexed > 0) {
      intermediateRetrieval = await f.core.retrieveContext({
        task_id: imported.task_id,
        queries: ["FIRST_SOURCE_READY_MARKER"],
        channels: ["bm25", "embedding"],
      })
    }
    if (status.status === "prepared") {
      finalStatus = status
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.ok(intermediateRetrieval, "at least one source must become queryable before the import job finishes")
  assert.equal(intermediateRetrieval.available_channels.includes("bm25"), true)
  assert.equal(intermediateRetrieval.hits.some((hit) => hit.snippet.includes("FIRST_SOURCE_READY_MARKER")), true)
  assert.equal(intermediateRetrieval.answer_scope, "task-local-ready-sources")
  assert.equal(intermediateRetrieval.retrieval_readiness.sources.by_source.some((source) => source.bm25_indexed_chunks > 0), true)
  assert.ok(finalStatus, "progressive import must reach prepared")
  assert.equal(finalStatus.retrieval_readiness.sources.bm25_indexed, files.length)
  assert.equal(finalStatus.retrieval_readiness.sources.by_source.every((source) => source.state === "bm25-ready"), true)
  const index = JSON.parse(await readFile(path.join(f.workspace, ".llm-wiki", "tasks", imported.task_id, "retrieval-index.json"), "utf8"))
  assert.equal(index.complete, true)
  assert.equal(index.bm25.documentCount > 0, true)
  assert.equal(index.featureHash.storage, "contiguous-float32-le")
})

test("retrieval indexes and recalls a lexical tail document beyond ten thousand chunks", async (t) => {
  const f = await fixture("llm-wiki-tail-recall-")
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const source = path.join(f.incoming, "tail.md")
  const sections = Array.from({ length: 10_050 }, (_, index) => (
    `## Record ${index}\n\n${index === 10_049 ? "TAIL_DOCUMENT_10049_NEEDLE" : `ordinary record ${index}`}`
  ))
  await writeFile(source, `# Tail corpus\n\n${sections.join("\n\n")}\n`)
  const imported = await f.core.importFiles({ files: [{ path: source }] })
  const retrieval = await f.core.retrieveContext({
    task_id: imported.task_id,
    queries: ["TAIL_DOCUMENT_10049_NEEDLE"],
    channels: ["bm25"],
    limit: 5,
  })
  assert.equal(retrieval.corpus.indexed_documents > 10_000, true)
  assert.equal(retrieval.corpus.truncated, false)
  assert.equal(retrieval.hits.some((hit) => hit.snippet.includes("TAIL_DOCUMENT_10049_NEEDLE")), true)
})

test("lease renewal preserves the fence and rejects a stale token", async (t) => {
  const f = await fixture("llm-wiki-lease-renew-")
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const source = path.join(f.incoming, "lease.md")
  await writeFile(source, `# Lease\n\n${"Fenced extraction evidence. ".repeat(600)}\n`)
  const imported = await f.core.importFiles({ files: [{ path: source }], options: { max_batch_chars: 1_000 } })
  const batch = await f.core.getBatch({ task_id: imported.task_id, worker_id: "lease-worker" })
  const renewed = await f.core.renewLease({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    worker_id: batch.worker_id,
    lease_token: batch.lease_token,
  })
  assert.equal(renewed.lease_token, batch.lease_token)
  assert.equal(renewed.lease_epoch, batch.lease_epoch)
  assert.equal(Date.parse(renewed.lease_expires_at) >= Date.parse(batch.lease_expires_at), true)
  await assert.rejects(
    () => f.core.renewLease({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      worker_id: batch.worker_id,
      lease_token: `${batch.lease_token}-stale`,
    }),
    (error) => error instanceof LlmWikiError && error.code === "LEASE_FENCED",
  )
})
