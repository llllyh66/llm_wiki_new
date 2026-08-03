import path from "node:path"
import { fail } from "./errors.js"
import { ensureDir, newId, nowIso, pathExists, readJson, sha256, stableStringify, writeJsonAtomic } from "./utils.js"

export const ACTIVE_TASK_STATUSES = ["importing", "parsing", "prepared", "extracting", "planning", "committing", "finalizing", "failed"]
const MAX_TASK_CHUNK_PAYLOAD_BYTES = 96 * 1024
const MIN_BATCH_PAYLOAD_BYTES = 128 * 1024
// These are transport-safety ceilings, not tuning defaults. Claude may persist
// a large MCP result as pretty JSON and read it line by line; one JSON string
// must therefore never contain an 80K source line even when workspace limits
// were raised or came from an older task.
const MAX_AGENT_CHUNK_CHARS = 6_000
const MAX_AGENT_BATCH_CHARS = 24_000
const MAX_AGENT_NESTED_STRING_CHARS = 6_000

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
  const maxChunkChars = Math.min(workspace.config.limits.maxChunkChars, MAX_AGENT_CHUNK_CHARS)
  const requestedBatchChars = Number(options.maxBatchChars)
  const maxBatchChars = Number.isFinite(requestedBatchChars)
    ? Math.min(Math.max(requestedBatchChars, 1_000), workspace.config.limits.maxBatchChars, MAX_AGENT_BATCH_CHARS)
    : Math.min(workspace.config.limits.maxBatchChars, MAX_AGENT_BATCH_CHARS)
  // A single chunk must fit both the chunk and batch limits. Otherwise a
  // one-chunk batch can remain oversized forever and be rebuilt on every
  // get_batch call, which also invalidates parallel worker leases.
  const allChunks = boundTaskChunks(
    sources.flatMap((source) => source.chunks),
    Math.min(maxChunkChars, maxBatchChars),
  )
  const batches = makeBatches(taskId, allChunks, maxBatchChars)
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
    batchLeases: {},
    batchCompletedAt: {},
    pageProjection: {
      batchThreshold: 4,
      debounceMs: 30_000,
      projectedBatchIds: [],
      revision: 0,
      lease: null,
      lastCommittedAt: null,
      finalCompleted: false,
      provisionalPagePaths: [],
    },
    analysisRevision: 0,
    pagePlanRevision: 0,
    commitRevision: 0,
    retryCount: 0,
    ...(options.domainSchema ? { domainSchema: options.domainSchema.metadata } : {}),
    options: {
      targetLanguage: options.targetLanguage ?? workspace.config.targetLanguage,
      maxChunkChars,
      maxBatchChars,
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
  let payloadBytes = 0
  const maxPayloadBytes = Math.max(MIN_BATCH_PAYLOAD_BYTES, maxChars * 8)
  const emit = () => {
    if (current.length === 0) return
    batches.push({ taskId, batchId: `batch-${String(batches.length + 1).padStart(4, "0")}`, chunks: current, charCount: chars, payloadBytes })
    current = []
    chars = 0
    payloadBytes = 0
  }
  for (const chunk of chunks) {
    const chunkBytes = Buffer.byteLength(JSON.stringify(chunk))
    if (current.length > 0 && (chars + chunk.text.length > maxChars || payloadBytes + chunkBytes > maxPayloadBytes)) emit()
    current.push(chunk)
    chars += chunk.text.length
    payloadBytes += chunkBytes
    if (chars >= maxChars || payloadBytes >= maxPayloadBytes) emit()
  }
  emit()
  return batches
}

export async function ensureBoundedTaskBatches(record, limits) {
  let changed = false
  const batches = []
  const maxBatchChars = Math.min(
    finitePositive(record.task.options?.maxBatchChars) ?? limits.maxBatchChars,
    limits.maxBatchChars,
    MAX_AGENT_BATCH_CHARS,
  )
  const maxChunkChars = Math.min(
    finitePositive(record.task.options?.maxChunkChars) ?? limits.maxChunkChars,
    limits.maxChunkChars,
    maxBatchChars,
    MAX_AGENT_CHUNK_CHARS,
  )
  for (const batch of record.batches) {
    if (record.task.completedBatchIds.includes(batch.batchId)) {
      batches.push(batch)
      continue
    }
    const bounded = boundTaskChunks(
      batch.chunks,
      maxChunkChars,
    )
    const rebuilt = makeBatches(record.task.taskId, bounded, maxBatchChars)
    const originalBytes = batch.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(JSON.stringify(chunk)), 0)
    const needsRebuild = bounded.length !== batch.chunks.length
      || bounded.some((chunk, index) => chunk.chunkId !== batch.chunks[index]?.chunkId)
      || batch.charCount > maxBatchChars
      || originalBytes > Math.max(MIN_BATCH_PAYLOAD_BYTES, maxBatchChars * 8)
    if (!needsRebuild) {
      batches.push(batch)
      continue
    }
    changed = true
    rebuilt.forEach((item, index) => {
      batches.push({
        ...item,
        batchId: index === 0 ? batch.batchId : `${batch.batchId}-part-${String(index + 1).padStart(4, "0")}`,
      })
    })
  }
  if (!changed) return record
  record.batches = batches
  record.task.batchCount = batches.length
  record.task.options = { ...(record.task.options ?? {}), maxChunkChars, maxBatchChars }
  const persistedBatchIds = new Set(batches.map((batch) => batch.batchId))
  record.task.batchLeases = Object.fromEntries(Object.entries(record.task.batchLeases ?? {})
    .filter(([batchId]) => persistedBatchIds.has(batchId) && !record.task.completedBatchIds.includes(batchId)))
  if (record.task.activeBatchId && !persistedBatchIds.has(record.task.activeBatchId)) record.task.activeBatchId = undefined
  await writeJsonAtomic(record.paths.batches, batches)
  await saveTask(record.paths, record.task)
  return record
}

function boundTaskChunks(chunks, maxChars) {
  return chunks.flatMap((chunk) => {
    const text = typeof chunk?.text === "string" ? chunk.text : ""
    const payloadBytes = Buffer.byteLength(JSON.stringify(chunk))
    const nestedStringChars = maxNestedStringChars(chunk?.structuredData)
    if (text.length <= maxChars
      && payloadBytes <= MAX_TASK_CHUNK_PAYLOAD_BYTES
      && nestedStringChars <= MAX_AGENT_NESTED_STRING_CHARS) return [chunk]
    const pieces = splitChunkText(text, maxChars)
    return pieces.map((piece, index) => {
      const { structuredData: _structuredData, ...base } = chunk
      return {
        ...base,
        chunkId: `chunk-${sha256(`${chunk.chunkId}:${index}:${piece}`).slice(0, 24)}`,
        parentChunkId: chunk.chunkId,
        partIndex: index,
        headingPath: Array.isArray(chunk.headingPath) ? chunk.headingPath.map((heading) => String(heading).slice(0, 500)).slice(0, 12) : [],
        text: piece,
        tokenEstimate: Math.ceil(piece.length / 4),
        contentHash: sha256(piece),
        ...(Array.isArray(chunk.structuredData) ? { structuredData: compactStructuredData(chunk.structuredData) } : {}),
      }
    })
  })
}

function maxNestedStringChars(value) {
  let maximum = 0
  const visit = (current) => {
    if (typeof current === "string") {
      maximum = Math.max(maximum, current.length)
      return
    }
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (current && typeof current === "object") Object.values(current).forEach(visit)
  }
  visit(value)
  return maximum
}

function finitePositive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function compactStructuredData(values) {
  return values.slice(0, 20).map((value) => ({
    kind: "table",
    compacted: true,
    ...(typeof value?.sheetName === "string" ? { sheetName: value.sheetName.slice(0, 500) } : {}),
    ...(typeof value?.cellRange === "string" ? { cellRange: value.cellRange.slice(0, 100) } : {}),
    ...(typeof value?.sheetState === "string" ? { sheetState: value.sheetState.slice(0, 100) } : {}),
  }))
}

function splitChunkText(text, maxChars) {
  if (!text) return [""]
  const pieces = []
  let rest = text
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1)
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf(". "), window.lastIndexOf(" "), Math.floor(maxChars * 0.6))
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.trim() || pieces.length === 0) pieces.push(rest.trim())
  return pieces
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
