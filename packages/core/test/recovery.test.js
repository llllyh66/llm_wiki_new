import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { taskPaths, withIdempotency } from "../src/task-store.js"
import { sha256, stableStringify, writeJsonAtomic, readJson, nowIso } from "../src/utils.js"
import { ensureWorkspace } from "../src/workspace.js"
import { cleanupTransactionArtifacts, recoverPendingPageTransactions } from "../src/transaction.js"

async function idempotencyFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-recovery-"))
  const paths = taskPaths({ tasks: path.join(root, "tasks") }, "task-recovery")
  await mkdir(paths.root, { recursive: true })
  await mkdir(paths.idempotencyDir, { recursive: true })
  return { root, paths }
}

test("pending idempotency with a durable response is promoted and replayed", async (t) => {
  const fixture = await idempotencyFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const key = "recovery-key-v1"
  const request = { operation: "commit_pages", taskId: "task-recovery", patchCount: 1 }
  const shard = path.join(fixture.paths.idempotencyDir, `${sha256(key)}.json`)
  const responsePath = `${shard}.response.json`
  await writeJsonAtomic(fixture.paths.idempotencyMarker, { version: 2, storage: "sha256-key-shards" })
  await writeJsonAtomic(shard, {
    schemaVersion: 2,
    status: "pending",
    operationId: "op-crash-window",
    key,
    requestHash: sha256(stableStringify(request)),
    createdAt: new Date().toISOString(),
  })
  const durableResponse = { accepted: true, transaction_id: "txn-recovered" }
  await writeJsonAtomic(responsePath, durableResponse)

  const replay = await withIdempotency(fixture.paths, key, request, async () => {
    throw new Error("a recovered operation must not execute again")
  })
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.response, durableResponse)
  const committed = JSON.parse(await readFile(shard, "utf8"))
  assert.equal(committed.status, "committed")
  assert.deepEqual(committed.response, durableResponse)
  await assert.rejects(() => readFile(responsePath), { code: "ENOENT" })
})

test("pending idempotency without a durable response fails closed", async (t) => {
  const fixture = await idempotencyFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const key = "recovery-key-v2"
  const request = { operation: "commit_analysis", taskId: "task-recovery", batchId: "batch-0001" }
  const shard = path.join(fixture.paths.idempotencyDir, `${sha256(key)}.json`)
  await writeJsonAtomic(fixture.paths.idempotencyMarker, { version: 2, storage: "sha256-key-shards" })
  await writeJsonAtomic(shard, {
    schemaVersion: 2,
    status: "pending",
    operationId: "op-unresolved",
    key,
    requestHash: sha256(stableStringify(request)),
    createdAt: new Date().toISOString(),
  })

  let executed = false
  await assert.rejects(
    () => withIdempotency(fixture.paths, key, request, async () => {
      executed = true
      return { accepted: true }
    }),
    (error) => error.code === "IDEMPOTENCY_RECOVERY_REQUIRED",
  )
  assert.equal(executed, false)
})

test("a successful idempotent operation persists its response before commit", async (t) => {
  const fixture = await idempotencyFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const key = "recovery-key-v3"
  const request = { operation: "commit_analysis", taskId: "task-recovery", batchId: "batch-0002" }
  const response = { accepted: true, analysis_revision: 2 }
  const result = await withIdempotency(fixture.paths, key, request, async ({ persistResponse }) => {
    await persistResponse(response)
    return response
  })
  assert.equal(result.replayed, false)
  assert.deepEqual(result.response, response)
})

test("startup transaction recovery completes a durable staged page and links its task ledger", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-transaction-recovery-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = await ensureWorkspace(root)
  const taskId = `task-${randomUUID()}`
  const taskRoot = path.join(workspace.paths.tasks, taskId)
  await mkdir(taskRoot, { recursive: true })
  await writeJsonAtomic(path.join(taskRoot, "task.json"), {
    taskId,
    status: "committing",
    commitRevision: 0,
    wikiRevision: null,
    updatedAt: nowIso(),
  })
  await writeJsonAtomic(path.join(taskRoot, "commits.json"), [])

  const transactionId = `txn-${randomUUID()}`
  const transactionRoot = path.join(workspace.paths.journal, transactionId)
  const staged = path.join(transactionRoot, "staging", "wiki", "topics", "recovered.md")
  const content = "# Recovered\n\nDurably staged page.\n"
  await mkdir(path.dirname(staged), { recursive: true })
  await writeFile(staged, content)
  await writeJsonAtomic(path.join(transactionRoot, "transaction.json"), {
    schemaVersion: 2,
    state: "applying",
    transactionId,
    taskId,
    createdAt: nowIso(),
    appliedPaths: [],
    targets: [{
      path: "wiki/topics/recovered.md",
      existed: false,
      previousHash: null,
      fileHash: sha256(content),
      stagedPath: "staging/wiki/topics/recovered.md",
      backupPath: "backup/wiki/topics/recovered.md",
    }],
    patches: [],
  })

  await recoverPendingPageTransactions(workspace)
  assert.equal(await readFile(path.join(workspace.paths.root, "wiki/topics/recovered.md"), "utf8"), content)
  const journal = await readJson(path.join(transactionRoot, "transaction.json"))
  assert.equal(journal.state, "committed")
  const task = await readJson(path.join(taskRoot, "task.json"))
  assert.deepEqual(await readJson(path.join(taskRoot, "commits.json")), [transactionId])
  assert.equal(task.commitRevision, 1)
  assert.equal(task.wikiRevision, journal.wikiRevision)
})

test("terminal transaction backups are evicted immediately when the byte budget is exceeded", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-journal-budget-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = await ensureWorkspace(root)
  workspace.config.journal = { retentionDays: 30, maxBackupBytes: 1_024 }
  for (let index = 0; index < 2; index += 1) {
    const transactionId = `txn-${randomUUID()}`
    const transactionRoot = path.join(workspace.paths.journal, transactionId)
    const backup = path.join(transactionRoot, "backup", "wiki", "topics", `page-${index}.md`)
    await mkdir(path.dirname(backup), { recursive: true })
    await writeFile(backup, "x".repeat(900))
    await writeJsonAtomic(path.join(transactionRoot, "transaction.json"), {
      schemaVersion: 2,
      state: "committed",
      transactionId,
      committedAt: new Date(Date.now() - (2 - index) * 1_000).toISOString(),
      cleanupEligibleAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      targets: [],
      patches: [],
    })
  }

  const cleaned = await cleanupTransactionArtifacts(workspace)
  assert.equal(cleaned.overBudget, false)
  assert.equal(cleaned.retainedBytes <= 1_024, true)
  assert.equal(cleaned.budgetEvictedTransactions, 1)
})
