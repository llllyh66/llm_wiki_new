import { lstat, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fail } from "./errors.js"
import { assertNoSymlinkEscape, validatePagePath } from "./validation.js"
import { ensureDir, hashDirectory, nowIso, pathExists, readJson, sha256, writeJsonAtomic, writeTextAtomic } from "./utils.js"

export async function commitPageTransaction(workspace, task, patches, basedOnWikiRevision) {
  const lockPath = path.join(workspace.paths.locks, "write.lock")
  let lock
  try {
    lock = await open(lockPath, "wx", 0o600)
  } catch (error) {
    if (error?.code === "EEXIST") fail("WORKSPACE_LOCKED", "Another Wiki transaction is in progress.", { retryable: true })
    throw error
  }
  const transactionId = `txn-${randomUUID()}`
  const transactionRoot = path.join(workspace.paths.journal, transactionId)
  const stagingRoot = path.join(transactionRoot, "staging")
  const backupRoot = path.join(transactionRoot, "backup")
  const targets = []
  const applied = []
  try {
    await lock.writeFile(`${JSON.stringify({ transactionId, taskId: task.taskId, createdAt: nowIso() })}\n`)
    await lock.sync()
    const actualRevision = await hashDirectory(workspace.paths.wiki)
    if (actualRevision !== basedOnWikiRevision) {
      fail("WIKI_REVISION_CONFLICT", "The Wiki changed after page planning.", {
        retryable: true,
        taskId: task.taskId,
        details: { expected: basedOnWikiRevision, actual: actualRevision },
        suggestedAction: "Retrieve a fresh page plan context and rebase the patches.",
      })
    }
    await ensureDir(stagingRoot)
    await ensureDir(backupRoot)
    for (const patch of patches) {
      const relative = validatePagePath(patch.path)
      const target = await assertNoSymlinkEscape(workspace.paths.root, relative)
      const exists = await pathExists(target)
      let currentHash
      if (exists) {
        const info = await lstat(target)
        if (!info.isFile() || info.isSymbolicLink()) fail("INVALID_PAGE_PATH", "Existing page target is not a regular file.")
        currentHash = sha256(await readFile(target))
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
      await writeTextAtomic(staged, normalizePageContent(patch.content))
      targets.push({ patch, relative, target, staged, existed: exists, previousHash: currentHash })
    }

    for (const item of targets) {
      await ensureDir(path.dirname(item.target))
      const backup = path.join(backupRoot, item.relative)
      if (item.existed) {
        await ensureDir(path.dirname(backup))
        await rename(item.target, backup)
      }
      try {
        await rename(item.staged, item.target)
      } catch (error) {
        if (item.existed) await rename(backup, item.target).catch(() => {})
        throw error
      }
      applied.push({ ...item, backup })
    }
    const newRevision = await hashDirectory(workspace.paths.wiki)
    const journal = {
      schemaVersion: 1,
      transactionId,
      taskId: task.taskId,
      committedAt: nowIso(),
      basedOnWikiRevision,
      wikiRevision: newRevision,
      patches: targets.map((item) => ({
        patchId: item.patch.patchId,
        path: item.relative,
        operation: item.patch.operation,
        previousHash: item.previousHash ?? null,
        fileHash: sha256(normalizePageContent(item.patch.content)),
        title: item.patch.title,
        pageKind: item.patch.pageKind,
        sourceRefs: item.patch.sourceRefs,
        rationale: item.patch.rationale,
      })),
    }
    await writeJsonAtomic(path.join(transactionRoot, "transaction.json"), journal)
    return journal
  } catch (error) {
    for (const item of applied.reverse()) {
      await rm(item.target, { force: true }).catch(() => {})
      if (item.existed) await rename(item.backup, item.target).catch(() => {})
    }
    throw error
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    await lock.close().catch(() => {})
    await rm(lockPath, { force: true }).catch(() => {})
  }
}

function normalizePageContent(content) {
  return `${content.replace(/\r\n?/g, "\n").trimEnd()}\n`
}

export async function committedPageRecords(workspace, transactionIds) {
  const records = []
  for (const transactionId of transactionIds) {
    const journal = await readJson(path.join(workspace.paths.journal, transactionId, "transaction.json"))
    records.push(...journal.patches.map((patch) => ({ ...patch, transactionId })))
  }
  return records
}
