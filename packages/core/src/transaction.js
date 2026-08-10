import { lstat, readFile, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fail } from "./errors.js"
import { assertNoSymlinkEscape, validatePagePath } from "./validation.js"
import { acquireProcessFileLock, ensureDir, hashDirectory, nowIso, pathExists, readJson, sha256, writeJsonAtomic, writeTextAtomic } from "./utils.js"
import { prepareWikiPageContent } from "./wiki-page.js"

export async function commitPageTransaction(workspace, task, patches, basedOnWikiRevision) {
  const lockPath = path.join(workspace.paths.locks, "write.lock")
  let releaseLock
  try {
    releaseLock = await acquireProcessFileLock(lockPath, { kind: "wiki-transaction", taskId: task.taskId }, { waitMs: 0 })
  } catch (error) {
    if (error?.code === "FILE_LOCK_BUSY") fail("WORKSPACE_LOCKED", "Another Wiki transaction is in progress.", { retryable: true })
    throw error
  }
  const transactionId = `txn-${randomUUID()}`
  const transactionRoot = path.join(workspace.paths.journal, transactionId)
  const stagingRoot = path.join(transactionRoot, "staging")
  const backupRoot = path.join(transactionRoot, "backup")
  const targets = []
  const applied = []
  let journal
  try {
    const actualRevision = await hashDirectory(workspace.paths.wiki)
    // The Wiki revision covers the whole workspace. Another task may have
    // safely changed an unrelated page after this Writer collected its plan.
    // Rejecting that transaction creates needless global contention. The
    // create/replace checks below are the real optimistic-concurrency guard:
    // they validate every target path and its exact expected file hash while
    // this workspace transaction lock is held.
    const concurrentWikiChange = actualRevision !== basedOnWikiRevision
    await ensureDir(stagingRoot)
    await ensureDir(backupRoot)
    for (const patch of patches) {
      const relative = validatePagePath(patch.path)
      const target = await assertNoSymlinkEscape(workspace.paths.root, relative)
      const exists = await pathExists(target)
      let currentHash
      let currentContent = ""
      if (exists) {
        const info = await lstat(target)
        if (!info.isFile() || info.isSymbolicLink()) fail("INVALID_PAGE_PATH", "Existing page target is not a regular file.")
        currentContent = await readFile(target, "utf8")
        currentHash = sha256(currentContent)
      }
      if (patch.operation === "create" && exists) {
        fail("FILE_HASH_CONFLICT", `Page already exists: ${relative}`, {
          retryable: true,
          details: { path: relative, actual_file_hash: currentHash },
          suggestedAction: "Retrieve the existing page and submit a rebased replace or merge patch.",
        })
      }
      if (patch.operation !== "create") {
        if (!exists || !patch.expectedFileHash || currentHash !== patch.expectedFileHash) {
          fail("FILE_HASH_CONFLICT", `Page hash changed: ${relative}`, {
            retryable: true,
            details: { path: relative, expected_file_hash: patch.expectedFileHash, actual_file_hash: currentHash ?? null },
            suggestedAction: "Retrieve the latest page and rebase the patch.",
          })
        }
      }
      const staged = path.join(stagingRoot, relative)
      const preparedContent = prepareWikiPageContent(patch, currentContent)
      await writeTextAtomic(staged, preparedContent)
      targets.push({
        patch,
        relative,
        target,
        staged,
        preparedContent,
        existed: exists,
        previousHash: currentHash,
        fileHash: sha256(preparedContent),
        backup: path.join(backupRoot, relative),
      })
    }

    journal = {
      schemaVersion: 2,
      state: "prepared",
      transactionId,
      taskId: task.taskId,
      createdAt: nowIso(),
      basedOnWikiRevision,
      actualBaseRevision: actualRevision,
      concurrentWikiChange,
      appliedPaths: [],
      targets: targets.map((item) => ({
        path: item.relative,
        existed: item.existed,
        previousHash: item.previousHash ?? null,
        fileHash: item.fileHash,
        stagedPath: path.relative(transactionRoot, item.staged).split(path.sep).join("/"),
        backupPath: path.relative(transactionRoot, item.backup).split(path.sep).join("/"),
      })),
      patches: targets.map((item) => transactionPatchRecord(item)),
    }
    // The intent is durable before the first target is renamed. A killed
    // process can therefore distinguish an unapplied transaction from an
    // unknown external file mutation during startup recovery.
    await writeJsonAtomic(path.join(transactionRoot, "transaction.json"), journal)
    journal.state = "applying"
    await writeJsonAtomic(path.join(transactionRoot, "transaction.json"), journal)
    for (const item of targets) {
      await ensureDir(path.dirname(item.target))
      if (item.existed) {
        await ensureDir(path.dirname(item.backup))
        await rename(item.target, item.backup)
      }
      try {
        await rename(item.staged, item.target)
      } catch (error) {
        if (item.existed) await rename(item.backup, item.target).catch(() => {})
        throw error
      }
      applied.push(item)
      journal.appliedPaths.push(item.relative)
      await writeJsonAtomic(path.join(transactionRoot, "transaction.json"), { ...journal, state: "applying" })
    }
    const newRevision = await hashDirectory(workspace.paths.wiki)
    journal = {
      ...journal,
      state: "pages_applied",
      committedAt: nowIso(),
      wikiRevision: newRevision,
    }
    await writeJsonAtomic(path.join(transactionRoot, "transaction.json"), journal)
    return journal
  } catch (error) {
    for (const item of applied.reverse()) {
      await rm(item.target, { force: true }).catch(() => {})
      if (item.existed) await rename(item.backup, item.target).catch(() => {})
    }
    if (journal) {
      await writeJsonAtomic(path.join(transactionRoot, "transaction.json"), {
        ...journal,
        state: "rolled_back",
        rolledBackAt: nowIso(),
        cleanupEligibleAt: cleanupEligibleAt(workspace, nowIso()),
      }).catch(() => {})
    }
    throw error
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    await releaseLock().catch(() => {})
  }
}

function transactionPatchRecord(item) {
  return {
    patchId: item.patch.patchId,
    path: item.relative,
    operation: item.patch.operation,
    previousHash: item.previousHash ?? null,
    fileHash: item.fileHash,
    title: item.patch.title,
    pageKind: item.patch.pageKind,
    sourceRefs: item.patch.sourceRefs,
    covers: item.patch.covers ?? [],
    related: item.patch.related ?? [],
    domainSchemaId: item.patch.domainSchemaId ?? "",
    domainSchemaVersion: item.patch.domainSchemaVersion ?? "",
    domainClassifications: item.patch.domainClassifications ?? [],
    summary: item.patch.summary ?? "",
    rationale: item.patch.rationale,
  }
}

export async function committedPageRecords(workspace, transactionIds) {
  const records = []
  for (const transactionId of transactionIds) {
    const journal = await readJson(path.join(workspace.paths.journal, transactionId, "transaction.json"))
    records.push(...journal.patches.map((patch) => ({ ...patch, transactionId })))
  }
  return records
}

export async function markPageTransactionCommitted(workspace, transactionId) {
  const journalPath = path.join(workspace.paths.journal, transactionId, "transaction.json")
  const journal = await readJson(journalPath)
  if (journal.state === "committed") return journal
  if (journal.state !== "pages_applied") {
    fail("TRANSACTION_RECOVERY_REQUIRED", `Transaction ${transactionId} is not ready to commit from state ${journal.state}.`, {
      retryable: true,
      details: { transaction_id: transactionId, state: journal.state },
    })
  }
  const committedAt = journal.committedAt ?? nowIso()
  const committed = {
    ...journal,
    state: "committed",
    committedAt,
    committedLedgerAt: nowIso(),
    cleanupEligibleAt: journal.cleanupEligibleAt ?? cleanupEligibleAt(workspace, committedAt),
  }
  await writeJsonAtomic(journalPath, committed)
  return committed
}

export async function cleanupTransactionArtifacts(workspace) {
  let release
  try {
    release = await acquireProcessFileLock(
      path.join(workspace.paths.locks, "journal-gc.lock"),
      { kind: "journal-artifact-gc" },
      { waitMs: 0 },
    )
  } catch {
    return { skipped: true, removedTransactions: 0, removedBytes: 0, retainedBytes: 0 }
  }
  try {
    const retentionDays = clampInteger(workspace.config.journal?.retentionDays, 1, 3_650, 7)
    const maxBackupBytes = clampInteger(workspace.config.journal?.maxBackupBytes, 1_024, 8 * 1024 * 1024 * 1024, 512 * 1024 * 1024)
    const now = Date.now()
    const entries = await readdir(workspace.paths.journal, { withFileTypes: true })
    const candidates = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^txn-[0-9a-f-]+$/i.test(entry.name)) continue
      const transactionRoot = path.join(workspace.paths.journal, entry.name)
      const journalPath = path.join(transactionRoot, "transaction.json")
      const journal = await readJson(journalPath, null)
      if (!journal || !["committed", "rolled_back"].includes(journal.state)) continue
      const backupRoot = path.join(transactionRoot, "backup")
      const stagingRoot = path.join(transactionRoot, "staging")
      const backupStats = await artifactStats(backupRoot)
      const stagingStats = await artifactStats(stagingRoot)
      const artifactBytes = backupStats.bytes + stagingStats.bytes
      if (artifactBytes === 0) continue
      const terminalAt = Date.parse(journal.committedAt ?? journal.rolledBackAt ?? journal.createdAt ?? 0)
      const eligibleAt = Date.parse(journal.cleanupEligibleAt ?? new Date(terminalAt + retentionDays * 86_400_000).toISOString())
      candidates.push({ journalPath, journal, backupRoot, stagingRoot, artifactBytes, eligibleAt, terminalAt })
    }
    let retainedBytes = candidates.reduce((sum, candidate) => sum + candidate.artifactBytes, 0)
    const expired = candidates
      .filter((candidate) => Number.isFinite(candidate.eligibleAt) && candidate.eligibleAt <= now)
      .sort((left, right) => left.eligibleAt - right.eligibleAt)
    const removed = []
    const removeCandidate = async (candidate, reason) => {
      await removeArtifactDirectory(candidate.backupRoot)
      await removeArtifactDirectory(candidate.stagingRoot)
      retainedBytes -= candidate.artifactBytes
      removed.push({ ...candidate, reason })
      await writeJsonAtomic(candidate.journalPath, {
        ...candidate.journal,
        artifactsCleanedAt: nowIso(),
        artifactsCleanedBytes: candidate.artifactBytes,
        artifactsCleanupReason: reason,
      })
    }
    for (const candidate of expired) await removeCandidate(candidate, "retention_expired")
    const expiredSet = new Set(expired.map((candidate) => candidate.journalPath))
    const budgetCandidates = candidates
      .filter((candidate) => !expiredSet.has(candidate.journalPath))
      .sort((left, right) => {
        const leftTime = Number.isFinite(left.terminalAt) ? left.terminalAt : 0
        const rightTime = Number.isFinite(right.terminalAt) ? right.terminalAt : 0
        return leftTime - rightTime
      })
    for (const candidate of budgetCandidates) {
      if (retainedBytes <= maxBackupBytes) break
      await removeCandidate(candidate, "backup_budget_exceeded")
    }
    return {
      skipped: false,
      removedTransactions: removed.length,
      removedBytes: removed.reduce((sum, candidate) => sum + candidate.artifactBytes, 0),
      retainedBytes,
      overBudget: retainedBytes > maxBackupBytes,
      budgetEvictedTransactions: removed.filter((candidate) => candidate.reason === "backup_budget_exceeded").length,
    }
  } finally {
    await release?.().catch(() => {})
  }
}

export async function recoverPendingPageTransactions(workspace) {
  let release
  try {
    release = await acquireProcessFileLock(
      path.join(workspace.paths.locks, "write.lock"),
      { kind: "wiki-transaction-recovery" },
      { waitMs: 5_000 },
    )
  } catch (error) {
    if (error?.code === "FILE_LOCK_BUSY") fail("WORKSPACE_LOCKED", "A Wiki transaction is active while recovery is starting.", { retryable: true })
    throw error
  }
  const recovered = []
  try {
    const entries = await readdir(workspace.paths.journal, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^txn-[0-9a-f-]+$/i.test(entry.name)) continue
      const transactionRoot = path.join(workspace.paths.journal, entry.name)
      const journalPath = path.join(transactionRoot, "transaction.json")
      const journal = await readJson(journalPath, null)
      if (!journal || ["committed", "rolled_back", "recovery_required"].includes(journal.state)) continue
      if (journal.state === "pages_applied") {
        await reconcilePageTransactionLedger(workspace, journal)
        continue
      }
      if (!Array.isArray(journal.targets) || journal.targets.length === 0) {
        await writeJsonAtomic(journalPath, { ...journal, state: "recovery_required", recoveryReason: "missing transaction targets", recoveryAt: nowIso() })
        fail("TRANSACTION_RECOVERY_REQUIRED", `Transaction ${entry.name} has no recoverable target manifest.`, {
          retryable: true,
          details: { transaction_id: entry.name, state: journal.state },
        })
      }
      const result = await recoverOneTransaction(workspace, transactionRoot, journal)
      if (result.state === "pages_applied") await reconcilePageTransactionLedger(workspace, { ...journal, ...await readJson(journalPath) })
      recovered.push(result)
    }
  } finally {
    await release?.().catch(() => {})
  }
  return recovered
}

async function reconcilePageTransactionLedger(workspace, journal) {
  const taskRoot = path.join(workspace.paths.tasks, journal.taskId)
  const taskPath = path.join(taskRoot, "task.json")
  const commitsPath = path.join(taskRoot, "commits.json")
  const task = await readJson(taskPath, null)
  const commits = await readJson(commitsPath, null)
  if (!task || !Array.isArray(commits)) {
    await markRecoveryRequired(path.join(workspace.paths.journal, journal.transactionId), journal, "task ledger is missing")
    fail("TRANSACTION_RECOVERY_REQUIRED", `Transaction ${journal.transactionId} cannot reconcile its task ledger.`, {
      retryable: true,
      details: { transaction_id: journal.transactionId, task_id: journal.taskId },
    })
  }
  if (!commits.includes(journal.transactionId)) {
    commits.push(journal.transactionId)
    await writeJsonAtomic(commitsPath, commits)
    task.commitRevision = (Number(task.commitRevision) || 0) + 1
    task.wikiRevision = journal.wikiRevision
    task.updatedAt = nowIso()
    await writeJsonAtomic(taskPath, task)
  } else if (task.wikiRevision !== journal.wikiRevision) {
    task.wikiRevision = journal.wikiRevision
    task.updatedAt = nowIso()
    await writeJsonAtomic(taskPath, task)
  }
  await markPageTransactionCommitted(workspace, journal.transactionId)
}

async function recoverOneTransaction(workspace, transactionRoot, journal) {
  const targetStates = []
  for (const item of journal.targets) {
    const target = await assertNoSymlinkEscape(workspace.paths.root, item.path)
    const staged = safeJournalPath(transactionRoot, item.stagedPath)
    const backup = safeJournalPath(transactionRoot, item.backupPath)
    const currentHash = await regularFileHash(target)
    const stagedHash = await regularFileHash(staged)
    const expectedOld = item.previousHash ?? null
    const expectedNew = item.fileHash
    if (currentHash === expectedNew) {
      targetStates.push({ item, target, staged, backup, status: "applied" })
      continue
    }
    if (currentHash !== expectedOld && currentHash !== null) {
      await markRecoveryRequired(transactionRoot, journal, `unexpected target hash for ${item.path}`)
      fail("TRANSACTION_RECOVERY_REQUIRED", `Transaction ${journal.transactionId} found an externally changed target: ${item.path}.`, {
        retryable: true,
        details: { transaction_id: journal.transactionId, path: item.path, expected_old_hash: expectedOld, expected_new_hash: expectedNew, actual_hash: currentHash },
      })
    }
    if (stagedHash !== expectedNew) {
      // If every target is still at its old hash and there is no staged
      // payload, the operation never applied and can be safely considered
      // rolled back. A mixed state is not safe to guess through.
      const allOld = journal.targets.every((candidate) => candidate.previousHash === null)
        ? currentHash === null
        : false
      if (allOld && journal.targets.length === 1) {
        await writeJsonAtomic(path.join(transactionRoot, "transaction.json"), { ...journal, state: "rolled_back", rolledBackAt: nowIso(), recoveryReason: "intent was not applied" })
        return { transactionId: journal.transactionId, state: "rolled_back" }
      }
      await markRecoveryRequired(transactionRoot, journal, `missing staged payload for ${item.path}`)
      fail("TRANSACTION_RECOVERY_REQUIRED", `Transaction ${journal.transactionId} is missing staged data for ${item.path}.`, {
        retryable: true,
        details: { transaction_id: journal.transactionId, path: item.path, state: journal.state },
      })
    }
    targetStates.push({ item, target, staged, backup, status: "pending" })
  }

  for (const state of targetStates.filter((item) => item.status === "pending")) {
    const currentHash = await regularFileHash(state.target)
    if (state.item.existed && currentHash === state.item.previousHash && !(await pathExists(state.backup))) {
      await ensureDir(path.dirname(state.backup))
      await rename(state.target, state.backup)
    } else if (state.item.existed && currentHash === null && !(await pathExists(state.backup))) {
      await markRecoveryRequired(transactionRoot, journal, `missing backup for ${state.item.path}`)
      fail("TRANSACTION_RECOVERY_REQUIRED", `Transaction ${journal.transactionId} cannot restore the old target: ${state.item.path}.`, {
        retryable: true,
        details: { transaction_id: journal.transactionId, path: state.item.path },
      })
    }
    await ensureDir(path.dirname(state.target))
    await rename(state.staged, state.target)
  }
  const wikiRevision = await hashDirectory(workspace.paths.wiki)
  const completed = {
    ...journal,
    state: "pages_applied",
    appliedPaths: journal.targets.map((item) => item.path),
    wikiRevision,
    recoveredAt: nowIso(),
  }
  await writeJsonAtomic(path.join(transactionRoot, "transaction.json"), completed)
  return { transactionId: journal.transactionId, state: completed.state, taskId: journal.taskId }
}

function cleanupEligibleAt(workspace, terminalAt) {
  const retentionDays = clampInteger(workspace.config.journal?.retentionDays, 1, 3_650, 7)
  const timestamp = Date.parse(terminalAt)
  return new Date((Number.isFinite(timestamp) ? timestamp : Date.now()) + retentionDays * 86_400_000).toISOString()
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback
}

async function artifactStats(root) {
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    if (error?.code === "ENOENT") return { bytes: 0, files: 0 }
    throw error
  }
  if (info.isSymbolicLink()) return { bytes: 0, files: 0, unsafe: true }
  if (info.isFile()) return { bytes: info.size, files: 1 }
  if (!info.isDirectory()) return { bytes: 0, files: 0 }
  let bytes = 0
  let files = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const nested = await artifactStats(path.join(root, entry.name))
    bytes += nested.bytes
    files += nested.files
  }
  return { bytes, files }
}

async function removeArtifactDirectory(root) {
  try {
    const info = await lstat(root)
    if (info.isSymbolicLink()) return
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}

function safeJournalPath(root, relative) {
  const candidate = path.resolve(root, String(relative ?? ""))
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    fail("TRANSACTION_RECOVERY_REQUIRED", "Transaction journal contains a path outside its transaction directory.", { retryable: true })
  }
  return candidate
}

async function regularFileHash(filePath) {
  try {
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink()) fail("TRANSACTION_RECOVERY_REQUIRED", `Transaction path is not a regular file: ${filePath}`, { retryable: true })
    return sha256(await readFile(filePath))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function markRecoveryRequired(transactionRoot, journal, reason) {
  await writeJsonAtomic(path.join(transactionRoot, "transaction.json"), {
    ...journal,
    state: "recovery_required",
    recoveryReason: reason,
    recoveryAt: nowIso(),
  }).catch(() => {})
}
