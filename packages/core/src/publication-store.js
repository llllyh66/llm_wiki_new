import { readdir, rm } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"
import { nowIso, pathExists, readJson, writeJsonAtomic } from "./utils.js"

const TERMINAL_OWNER_STATUSES = new Set(["completed", "cancelled"])

export async function publicationState(workspace, currentTaskId) {
  const resolved = await resolvePublicationOwner(workspace, { repair: false })
  if (!resolved.owner) return { state: "available", current_task_is_owner: false }
  return {
    state: resolved.owner.taskId === currentTaskId ? "owned" : "waiting",
    owner_task_id: resolved.owner.taskId,
    current_task_is_owner: resolved.owner.taskId === currentTaskId,
    acquired_at: resolved.owner.acquiredAt,
    base_wiki_revision: resolved.owner.baseWikiRevision,
    owner_status: resolved.task?.status ?? null,
    owner_provisional_pages: resolved.task?.pageProjection?.provisionalPagePaths?.length ?? 0,
  }
}

// The caller must hold the workspace write.lock. Publication ownership is
// durable across individual transactions: once a task writes a provisional
// page, no other task may publish until that task finalizes the shared Wiki.
export async function claimPublicationOwner(workspace, task, baseWikiRevision) {
  const resolved = await resolvePublicationOwner(workspace, { repair: true })
  if (resolved.owner?.taskId === task.taskId) return { claimed: false, owner: resolved.owner }
  if (resolved.owner) {
    fail("WIKI_PUBLICATION_BUSY", `Task ${resolved.owner.taskId} owns Wiki publication.`, {
      retryable: true,
      taskId: task.taskId,
      details: {
        owner_task_id: resolved.owner.taskId,
        owner_status: resolved.task?.status ?? null,
        owner_provisional_pages: resolved.task?.pageProjection?.provisionalPagePaths?.length ?? 0,
        acquired_at: resolved.owner.acquiredAt,
        atomic_commit_applied: false,
      },
      suggestedAction: `Resume and finalize ${resolved.owner.taskId} before publishing this task.`,
    })
  }
  const owner = {
    schemaVersion: 1,
    taskId: task.taskId,
    acquiredAt: nowIso(),
    baseWikiRevision,
    state: "projecting",
  }
  await writeJsonAtomic(workspace.paths.publicationOwner, owner)
  return { claimed: true, owner }
}

// The caller must hold the workspace write.lock.
export async function releasePublicationOwner(workspace, task) {
  const owner = await readJson(workspace.paths.publicationOwner, null)
  if (!owner || owner.taskId !== task.taskId) return false
  const provisional = task.pageProjection?.provisionalPagePaths ?? []
  if (task.status !== "completed" || provisional.length > 0) return false
  await rm(workspace.paths.publicationOwner, { force: true })
  return true
}

// Release a newly claimed owner when validation/hash checks rejected a
// transaction before any page was changed. Existing owners are never released
// by a failed wave because earlier provisional commits still belong to them.
export async function releaseUnusedPublicationClaim(workspace, taskId) {
  const owner = await readJson(workspace.paths.publicationOwner, null)
  if (!owner || owner.taskId !== taskId) return false
  const task = await readTask(workspace, taskId)
  if ((task?.pageProjection?.provisionalPagePaths ?? []).length > 0) return false
  await rm(workspace.paths.publicationOwner, { force: true })
  return true
}

async function resolvePublicationOwner(workspace, { repair }) {
  const persisted = await readJson(workspace.paths.publicationOwner, null)
  if (persisted?.taskId) {
    const task = await readTask(workspace, persisted.taskId)
    const provisional = task ? await existingProvisionalPaths(workspace, task) : []
    if (task && (!TERMINAL_OWNER_STATUSES.has(task.status) || provisional.length > 0)) {
      return { owner: persisted, task }
    }
    if (!repair) return { owner: null, task }
    await rm(workspace.paths.publicationOwner, { force: true })
  }

  const legacyOwners = await legacyProvisionalOwners(workspace)
  if (legacyOwners.length > 1) {
    fail("PROVISIONAL_OWNERSHIP_INCONSISTENT", "Multiple legacy tasks own provisional Wiki pages.", {
      retryable: true,
      details: {
        owner_tasks: legacyOwners.map(({ task }) => ({
          task_id: task.taskId,
          status: task.status,
          provisional_page_count: task.pageProjection.provisionalPagePaths.length,
        })),
      },
      suggestedAction: "Finish the existing provisional owner tasks in a deliberate order before starting another Wiki publisher.",
    })
  }
  if (legacyOwners.length === 1) {
    const task = legacyOwners[0].task
    const owner = {
      schemaVersion: 1,
      taskId: task.taskId,
      acquiredAt: task.pageProjection?.lastCommittedAt ?? task.updatedAt ?? nowIso(),
      baseWikiRevision: task.wikiRevision ?? null,
      state: "projecting",
      recoveredFromLegacyState: true,
    }
    if (repair) await writeJsonAtomic(workspace.paths.publicationOwner, owner)
    return { owner, task }
  }
  return { owner: null, task: null }
}

async function legacyProvisionalOwners(workspace) {
  if (!(await pathExists(workspace.paths.tasks))) return []
  const entries = await readdir(workspace.paths.tasks, { withFileTypes: true })
  const owners = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("task-")) continue
    const task = await readTask(workspace, entry.name)
    if (task && (await existingProvisionalPaths(workspace, task)).length > 0) owners.push({ task })
  }
  return owners
}

async function existingProvisionalPaths(workspace, task) {
  const candidates = task?.pageProjection?.provisionalPagePaths ?? []
  const existing = []
  for (const relative of candidates) {
    if (typeof relative !== "string" || !relative.startsWith("wiki/")) continue
    if (await pathExists(path.join(workspace.paths.root, relative))) existing.push(relative)
  }
  return existing
}

async function readTask(workspace, taskId) {
  return readJson(path.join(workspace.paths.tasks, taskId, "task.json"), null)
}
