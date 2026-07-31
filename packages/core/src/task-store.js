import path from "node:path"
import { fail } from "./errors.js"
import { ensureDir, newId, nowIso, pathExists, readJson, sha256, stableStringify, writeJsonAtomic } from "./utils.js"

export const ACTIVE_TASK_STATUSES = ["importing", "parsing", "prepared", "extracting", "planning", "committing", "finalizing", "failed"]

export function taskPaths(workspacePaths, taskId) {
  const root = path.join(workspacePaths.tasks, taskId)
  return {
    root,
    task: path.join(root, "task.json"),
    batches: path.join(root, "batches.json"),
    analysis: path.join(root, "analysis"),
    idempotency: path.join(root, "idempotency.json"),
    commits: path.join(root, "commits.json"),
    result: path.join(root, "result.json"),
    domainSchema: path.join(root, "domain-schema.json"),
  }
}

export async function createTask(workspace, sources, options = {}) {
  const taskId = newId("task")
  const paths = taskPaths(workspace.paths, taskId)
  await ensureDir(paths.analysis)
  const allChunks = sources.flatMap((source) => source.chunks)
  const batches = makeBatches(taskId, allChunks, options.maxBatchChars ?? workspace.config.limits.maxBatchChars)
  const timestamp = nowIso()
  const task = {
    schemaVersion: 1,
    taskId,
    workspaceId: workspace.config.workspaceId,
    sourceIds: sources.map((source) => source.source_id),
    status: "prepared",
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceSnapshotHash: sha256(stableStringify(sources.map((source) => ({ sourceId: source.source_id, hash: source.content_hash })))),
    wikiRevision: workspace.revision,
    batchCount: batches.length,
    completedBatchIds: [],
    analysisRevision: 0,
    pagePlanRevision: 0,
    commitRevision: 0,
    retryCount: 0,
    ...(options.domainSchema ? { domainSchema: options.domainSchema.metadata } : {}),
    options: {
      targetLanguage: options.targetLanguage ?? workspace.config.targetLanguage,
      maxChunkChars: workspace.config.limits.maxChunkChars,
      maxBatchChars: options.maxBatchChars ?? workspace.config.limits.maxBatchChars,
      enableBm25: true,
      enableVector: true,
      enableGraph: true,
    },
  }
  if (options.domainSchema) await writeJsonAtomic(paths.domainSchema, options.domainSchema.schema)
  await writeJsonAtomic(paths.task, task)
  await writeJsonAtomic(paths.batches, batches)
  await writeJsonAtomic(paths.idempotency, {})
  await writeJsonAtomic(paths.commits, [])
  return { task, batches }
}

function makeBatches(taskId, chunks, maxChars) {
  const batches = []
  let current = []
  let chars = 0
  const emit = () => {
    if (current.length === 0) return
    batches.push({ taskId, batchId: `batch-${String(batches.length + 1).padStart(4, "0")}`, chunks: current, charCount: chars })
    current = []
    chars = 0
  }
  for (const chunk of chunks) {
    if (current.length > 0 && chars + chunk.text.length > maxChars) emit()
    current.push(chunk)
    chars += chunk.text.length
    if (chars >= maxChars) emit()
  }
  emit()
  return batches
}

export async function loadTask(workspacePaths, taskId) {
  if (typeof taskId !== "string" || !/^task-[0-9a-f-]{36}$/i.test(taskId)) fail("TASK_NOT_FOUND", "Invalid task ID.")
  const paths = taskPaths(workspacePaths, taskId)
  if (!(await pathExists(paths.task))) fail("TASK_NOT_FOUND", `Task not found: ${taskId}`)
  return { paths, task: await readJson(paths.task), batches: await readJson(paths.batches) }
}

export async function saveTask(paths, task) {
  task.updatedAt = nowIso()
  await writeJsonAtomic(paths.task, task)
}

export function assertTaskStatus(task, allowed) {
  if (!allowed.includes(task.status)) {
    fail("INVALID_TASK_STATE", `Task ${task.taskId} is ${task.status}; expected ${allowed.join(" or ")}.`, { taskId: task.taskId })
  }
}

export async function withIdempotency(paths, key, requestValue, operation) {
  if (typeof key !== "string" || key.length < 8 || key.length > 200) {
    fail("INVALID_INPUT", "idempotency_key must contain 8 to 200 characters.")
  }
  const store = await readJson(paths.idempotency, {})
  const requestHash = sha256(stableStringify(requestValue))
  const existing = store[key]
  if (existing) {
    if (existing.requestHash !== requestHash) fail("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different request.")
    return { replayed: true, response: existing.response }
  }
  const response = await operation()
  store[key] = { requestHash, response, createdAt: nowIso() }
  await writeJsonAtomic(paths.idempotency, store)
  return { replayed: false, response }
}
