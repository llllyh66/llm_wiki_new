import { stat } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"
import { ensureDir, newId, nowIso, pathExists, readJson, sha256, stableStringify, writeJsonAtomic } from "./utils.js"

export const ACTIVE_TASK_STATUSES = ["importing", "parsing", "prepared", "extracting", "planning", "committing", "finalizing", "failed"]
const MAX_TASK_CHUNK_PAYLOAD_BYTES = 20 * 1024
const MIN_BATCH_PAYLOAD_BYTES = 16 * 1024
const MAX_AGENT_BATCH_PAYLOAD_BYTES = 24 * 1024
// These are transport-safety ceilings, not tuning defaults. Claude may persist
// a large MCP result as pretty JSON and read it line by line; one JSON string
// must therefore never contain an 80K source line even when workspace limits
// were raised or came from an older task.
const MAX_AGENT_CHUNK_CHARS = 3_000
const DEFAULT_AGENT_BATCH_CHARS = 6_000
const LARGE_AGENT_BATCH_CHARS = 9_000
const LARGE_TASK_SOURCE_CHARS = 60_000
const MAX_AGENT_BATCH_CHARS = LARGE_AGENT_BATCH_CHARS
const MAX_AGENT_NESTED_STRING_CHARS = 3_000
const TASK_BATCH_BOUNDS_VERSION = 2
const TASK_CHUNK_PAYLOAD_VERSION = 2
const BATCH_FILE_CACHE_LIMIT = 12
const batchFileCache = new Map()

export function taskPaths(workspacePaths, taskId) {
  const root = path.join(workspacePaths.tasks, taskId)
  return {
    root,
    task: path.join(root, "task.json"),
    batches: path.join(root, "batches.json"),
    analysis: path.join(root, "analysis"),
    idempotency: path.join(root, "idempotency.json"),
    idempotencyDir: path.join(root, "idempotency"),
    idempotencyMarker: path.join(root, "idempotency", "version.json"),
    commits: path.join(root, "commits.json"),
    result: path.join(root, "result.json"),
    domainSchema: path.join(root, "domain-schema.json"),
    pagePlan: path.join(root, "page-plan.json"),
  }
}

export async function createTask(workspace, sources, options = {}) {
  const taskId = newId("task")
  const paths = taskPaths(workspace.paths, taskId)
  await ensureDir(paths.analysis)
  await ensureDir(paths.idempotencyDir)
  const maxChunkChars = Math.min(workspace.config.limits.maxChunkChars, MAX_AGENT_CHUNK_CHARS)
  const totalSourceChars = sources.flatMap((source) => source.chunks)
    .reduce((sum, chunk) => sum + (typeof chunk?.text === "string" ? chunk.text.length : 0), 0)
  const adaptiveBatchChars = totalSourceChars >= LARGE_TASK_SOURCE_CHARS
    ? LARGE_AGENT_BATCH_CHARS
    : DEFAULT_AGENT_BATCH_CHARS
  const requestedBatchChars = Number(options.maxBatchChars)
  const maxBatchChars = Number.isFinite(requestedBatchChars)
    ? Math.min(Math.max(requestedBatchChars, 1_000), workspace.config.limits.maxBatchChars, MAX_AGENT_BATCH_CHARS)
    : Math.min(workspace.config.limits.maxBatchChars, adaptiveBatchChars)
  // A single chunk must fit both the chunk and batch limits. Otherwise a
  // one-chunk batch can remain oversized forever and be rebuilt on every
  // get_batch call, which also invalidates parallel worker leases.
  const maxBatchPayloadBytes = batchPayloadLimit(maxBatchChars)
  const allChunks = boundTaskChunks(
    sources.flatMap((source) => source.chunks),
    Math.min(maxChunkChars, maxBatchChars),
    Math.min(MAX_TASK_CHUNK_PAYLOAD_BYTES, maxBatchPayloadBytes),
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
    batchLayoutRevision: 0,
    batchBounds: batchBoundsRecord(maxChunkChars, maxBatchChars, maxBatchPayloadBytes),
    completedBatchIds: [],
    batchLeases: {},
    batchCompletedAt: {},
    pageProjection: {
      batchThreshold: 4,
      batchLimit: 8,
      writerProjectionQuantum: 6,
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
  await writeJsonAtomic(paths.idempotencyMarker, { version: 2, storage: "sha256-key-shards" })
  await writeJsonAtomic(paths.commits, [])
  return { task, batches }
}

function makeBatches(taskId, chunks, maxChars) {
  const batches = []
  let current = []
  let chars = 0
  let payloadBytes = 0
  const maxPayloadBytes = batchPayloadLimit(maxChars)
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
  const maxBatchPayloadBytes = batchPayloadLimit(maxBatchChars)
  const metadataWithinBounds = record.batches.length === record.task.batchCount
    && record.batches.every((batch) => batch.charCount <= maxBatchChars && Number(batch.payloadBytes) <= maxBatchPayloadBytes)
  if (metadataWithinBounds && batchBoundsCover(record.task.batchBounds, maxChunkChars, maxBatchChars, maxBatchPayloadBytes)) return record
  for (const batch of record.batches) {
    if (record.task.completedBatchIds.includes(batch.batchId)) {
      batches.push(batch)
      continue
    }
    const bounded = boundTaskChunks(
      batch.chunks,
      maxChunkChars,
      Math.min(MAX_TASK_CHUNK_PAYLOAD_BYTES, maxBatchPayloadBytes),
    )
    const rebuilt = makeBatches(record.task.taskId, bounded, maxBatchChars)
    const originalBytes = batch.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(JSON.stringify(chunk)), 0)
    const needsRebuild = bounded.length !== batch.chunks.length
      || bounded.some((chunk, index) => chunk.chunkId !== batch.chunks[index]?.chunkId)
      || batch.chunks.some((chunk) => chunk.taskPayloadVersion !== TASK_CHUNK_PAYLOAD_VERSION)
      || batch.charCount > maxBatchChars
      || originalBytes > maxBatchPayloadBytes
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
  record.task.batchBounds = batchBoundsRecord(maxChunkChars, maxBatchChars, maxBatchPayloadBytes)
  record.task.options = { ...(record.task.options ?? {}), maxChunkChars, maxBatchChars }
  if (!changed) {
    await saveTask(record.paths, record.task)
    return record
  }
  record.batches = batches
  record.task.batchCount = batches.length
  record.task.batchLayoutRevision = (Number(record.task.batchLayoutRevision) || 0) + 1
  const persistedBatchIds = new Set(batches.map((batch) => batch.batchId))
  record.task.batchLeases = Object.fromEntries(Object.entries(record.task.batchLeases ?? {})
    .filter(([batchId]) => persistedBatchIds.has(batchId) && !record.task.completedBatchIds.includes(batchId)))
  if (record.task.activeBatchId && !persistedBatchIds.has(record.task.activeBatchId)) record.task.activeBatchId = undefined
  await writeJsonAtomic(record.paths.batches, batches)
  batchFileCache.delete(record.paths.batches)
  await saveTask(record.paths, record.task)
  return record
}

function boundTaskChunks(chunks, maxChars, maxPayloadBytes = MAX_TASK_CHUNK_PAYLOAD_BYTES) {
  return chunks.flatMap((chunk) => {
    const compactedChunk = compactTaskChunk(chunk)
    const text = typeof compactedChunk?.text === "string" ? compactedChunk.text : ""
    const payloadBytes = Buffer.byteLength(JSON.stringify(compactedChunk))
    const nestedStringChars = maxNestedStringChars(compactedChunk?.structuredData)
    if (text.length <= maxChars
      && payloadBytes <= maxPayloadBytes
      && nestedStringChars <= MAX_AGENT_NESTED_STRING_CHARS) return [compactedChunk]
    const pieces = splitChunkText(text, maxChars)
    return pieces.map((piece, index) => {
      const { structuredData: _structuredData, ...base } = compactedChunk
      return {
        ...base,
        chunkId: `chunk-${sha256(`${chunk.chunkId}:${index}:${piece}`).slice(0, 24)}`,
        parentChunkId: chunk.chunkId,
        partIndex: index,
        headingPath: Array.isArray(chunk.headingPath) ? chunk.headingPath.map((heading) => String(heading).slice(0, 500)).slice(0, 12) : [],
        text: piece,
        tokenEstimate: Math.ceil(piece.length / 4),
        contentHash: sha256(piece),
        ...(Array.isArray(compactedChunk.structuredData) ? { structuredData: compactedChunk.structuredData } : {}),
      }
    })
  })
}

function compactTaskChunk(chunk) {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return chunk
  return {
    ...chunk,
    taskPayloadVersion: TASK_CHUNK_PAYLOAD_VERSION,
    ...(Array.isArray(chunk.structuredData) ? { structuredData: compactStructuredData(chunk.structuredData) } : {}),
  }
}

function batchPayloadLimit(maxChars) {
  return Math.min(
    MAX_AGENT_BATCH_PAYLOAD_BYTES,
    Math.max(MIN_BATCH_PAYLOAD_BYTES, Math.ceil(maxChars * 3.5)),
  )
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
    ...(value?.fragmented === true ? { fragmented: true } : {}),
  }))
}

function batchBoundsRecord(maxChunkChars, maxBatchChars, maxPayloadBytes) {
  return {
    version: TASK_BATCH_BOUNDS_VERSION,
    maxChunkChars,
    maxBatchChars,
    maxPayloadBytes,
    compactStructuredData: true,
  }
}

function batchBoundsCover(value, maxChunkChars, maxBatchChars, maxPayloadBytes) {
  return value?.version === TASK_BATCH_BOUNDS_VERSION
    && value.compactStructuredData === true
    && Number(value.maxChunkChars) <= maxChunkChars
    && Number(value.maxBatchChars) <= maxBatchChars
    && Number(value.maxPayloadBytes) <= maxPayloadBytes
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
  return { paths, task: await readJson(paths.task), batches: await readBatchesCached(paths.batches) }
}

async function readBatchesCached(filePath) {
  const info = await stat(filePath, { bigint: true })
  const signature = `${info.size}:${info.mtimeNs}`
  const cached = batchFileCache.get(filePath)
  if (cached?.signature === signature) return cached.value
  const value = await readJson(filePath)
  batchFileCache.set(filePath, { signature, value })
  while (batchFileCache.size > BATCH_FILE_CACHE_LIMIT) {
    batchFileCache.delete(batchFileCache.keys().next().value)
  }
  return value
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
  await ensureShardedIdempotency(paths)
  const shardPath = path.join(paths.idempotencyDir, `${sha256(key)}.json`)
  const requestHash = sha256(stableStringify(requestValue))
  const existing = await readJson(shardPath, null)
  if (existing) {
    if (existing.key !== key) fail("IDEMPOTENCY_CONFLICT", "The idempotency key hash collides with another stored key.")
    if (existing.requestHash !== requestHash) fail("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different request.")
    return { replayed: true, response: existing.response }
  }
  const response = await operation()
  await writeJsonAtomic(shardPath, { key, requestHash, response, createdAt: nowIso() })
  return { replayed: false, response }
}

async function ensureShardedIdempotency(paths) {
  if (await pathExists(paths.idempotencyMarker)) return
  await ensureDir(paths.idempotencyDir)
  const legacy = await readJson(paths.idempotency, {})
  for (const [key, value] of Object.entries(legacy)) {
    if (!value || typeof value !== "object") continue
    await writeJsonAtomic(path.join(paths.idempotencyDir, `${sha256(key)}.json`), { key, ...value })
  }
  await writeJsonAtomic(paths.idempotencyMarker, { version: 2, storage: "sha256-key-shards", migratedLegacyEntries: Object.keys(legacy).length })
}
