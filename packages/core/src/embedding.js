import { readdir, rm, stat, utimes } from "node:fs/promises"
import path from "node:path"
import { LlmWikiError } from "./errors.js"
import { acquireProcessFileLock, ensureDir, pathExists, readJson, sha256, stableStringify, writeJsonAtomic } from "./utils.js"

const MAX_EMBEDDING_DIMENSIONS = 8_192
const MAX_EMBEDDING_BATCH = 32
// Embedding calls are the only external operation with an AbortController.
// Keep a generous budget for large knowledge bases: this is a retrieval
// degradation timeout, not an MCP request timeout, and it must never close the
// long-lived STDIO connection.
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_TOTAL_TIMEOUT_MS = 600_000
const MAX_EMBEDDING_RESPONSE_BYTES = 16 * 1024 * 1024
const DEFAULT_CACHE_MAX_BYTES = 512 * 1024 * 1024
const DEFAULT_CACHE_MAX_FILES = 50_000
const DEFAULT_CACHE_TTL_DAYS = 30
const MAX_CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024
const MAX_CACHE_MAX_FILES = 250_000
const MAX_CACHE_TTL_DAYS = 3_650
const CACHE_GC_GRACE_MS = 5 * 60 * 1_000
const SUPPORTED_PROVIDERS = new Set(["none", "openai-compatible", "ollama"])

export function resolveEmbeddingConfig(workspace) {
  const configured = workspace.config.retrieval?.embedding ?? {}
  const provider = process.env.LLM_WIKI_EMBEDDING_PROVIDER || configured.provider || "none"
  const model = process.env.LLM_WIKI_EMBEDDING_MODEL || configured.model || ""
  const endpoint = process.env.LLM_WIKI_EMBEDDING_URL || configured.endpoint || defaultEndpoint(provider)
  const batchSize = clampInteger(configured.batchSize, 1, MAX_EMBEDDING_BATCH, 16)
  const timeoutMs = clampInteger(configured.timeoutMs, 1_000, 600_000, DEFAULT_TIMEOUT_MS)
  const totalTimeoutMs = clampInteger(configured.totalTimeoutMs, 5_000, 900_000, DEFAULT_TOTAL_TIMEOUT_MS)
  const maxInputChars = clampInteger(configured.maxInputChars, 1_000, 32_000, 8_000)
  const maxDocuments = clampInteger(configured.maxDocuments, 10, 10_000, 1_000)
  const maxCacheBytes = clampInteger(configured.maxCacheBytes, 1_024, MAX_CACHE_MAX_BYTES, DEFAULT_CACHE_MAX_BYTES)
  const maxCacheFiles = clampInteger(configured.maxCacheFiles, 10, MAX_CACHE_MAX_FILES, DEFAULT_CACHE_MAX_FILES)
  const cacheTtlDays = clampInteger(configured.cacheTtlDays, 1, MAX_CACHE_TTL_DAYS, DEFAULT_CACHE_TTL_DAYS)
  const supported = SUPPORTED_PROVIDERS.has(provider)
  const enabled = supported && provider !== "none" && Boolean(model && endpoint)
  return {
    enabled,
    supported,
    provider,
    model,
    endpoint,
    batchSize,
    timeoutMs,
    totalTimeoutMs,
    maxInputChars,
    maxDocuments,
    maxCacheBytes,
    maxCacheFiles,
    cacheTtlDays,
    apiKey: process.env.LLM_WIKI_EMBEDDING_API_KEY || "",
    // The endpoint is part of the embedding identity. Two compatible servers
    // may use the same provider/model names while producing different vector
    // spaces; reusing the old cache would silently corrupt RRF ranking.
    fingerprint: sha256(stableStringify({ provider, model, endpoint, maxInputChars })).slice(0, 24),
  }
}

export async function embedQueryAndDocuments(workspace, query, documents) {
  const config = resolveEmbeddingConfig(workspace)
  if (!config.enabled) {
    return { available: false, reason: config.supported ? "not_configured" : "unsupported_provider", config: publicConfig(config), vectors: new Map() }
  }
  const selected = documents.slice(0, config.maxDocuments)
  const deadline = Date.now() + config.totalTimeoutMs
  const cacheRoot = path.join(workspace.paths.indexes, "embeddings", config.fingerprint)
  const vectors = new Map()
  const missing = []
  try {
    await ensureDir(cacheRoot)
    for (const group of chunkArray(selected, 64)) {
      await Promise.all(group.map(async (document) => {
        const cached = await readCachedVector(cacheRoot, document.hash)
        if (cached) vectors.set(document.id, cached)
        else missing.push(document)
      }))
    }
    for (const group of chunkArray(missing, config.batchSize)) {
      const embedded = await requestWithinBudget(group.map((document) => boundedEmbeddingText(document, config.maxInputChars)), config, deadline)
      const cacheWrites = []
      for (let index = 0; index < group.length; index += 1) {
        const vector = normalizeVector(embedded[index])
        vectors.set(group[index].id, vector)
        cacheWrites.push(writeCachedVector(cacheRoot, group[index].hash, vector, config))
      }
      await Promise.all(cacheWrites)
    }
    const [queryVector] = await requestWithinBudget([String(query).slice(0, config.maxInputChars)], config, deadline)
    // Cache maintenance is best effort. A transient GC failure must not turn
    // an otherwise valid embedding response into retrieval degradation.
    await pruneEmbeddingCache(path.join(workspace.paths.indexes, "embeddings"), cacheRoot, selected.map((document) => document.hash), config).catch(() => {})
    return {
      available: true,
      queryVector: normalizeVector(queryVector),
      vectors,
      indexedDocuments: selected.length,
      skippedDocuments: Math.max(0, documents.length - selected.length),
      cacheHits: selected.length - missing.length,
      config: publicConfig(config),
    }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof LlmWikiError ? error.code : "EMBEDDING_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
      config: publicConfig(config),
      vectors: new Map(),
    }
  }
}

function requestWithinBudget(inputs, config, deadline) {
  const remaining = deadline - Date.now()
  if (remaining < 100) {
    throw new LlmWikiError("EMBEDDING_UNAVAILABLE", "Embedding operation exceeded its total time budget.", { retryable: true })
  }
  return requestEmbeddings(inputs, { ...config, timeoutMs: Math.min(config.timeoutMs, remaining) })
}

export async function warmEmbeddingCache(workspace, documents) {
  const config = resolveEmbeddingConfig(workspace)
  if (!config.enabled) return { status: "not_configured", provider: config.provider, model: config.model || null, indexed_documents: 0 }
  const result = await embedQueryAndDocuments(workspace, "embedding index warmup", documents)
  if (!result.available) return { status: "degraded", provider: config.provider, model: config.model, reason: result.reason, indexed_documents: 0 }
  return {
    status: result.skippedDocuments > 0 ? "partial" : "completed",
    provider: config.provider,
    model: config.model,
    indexed_documents: result.indexedDocuments,
    skipped_documents: result.skippedDocuments,
    cache_hits: result.cacheHits,
  }
}

async function requestEmbeddings(inputs, config) {
  if (inputs.length === 0) return []
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  let response
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(config.provider === "ollama"
        ? { model: config.model, input: inputs }
        : { model: config.model, input: inputs }),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timeout)
    throw new LlmWikiError("EMBEDDING_UNAVAILABLE", `Embedding request failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
  }
  if (!response.ok) {
    let detail = ""
    try {
      detail = (await readBoundedResponseText(response, 64 * 1024)).slice(0, 1_000)
    } catch {
      // The status code is sufficient when an error body is unavailable.
    } finally {
      clearTimeout(timeout)
    }
    throw new LlmWikiError("EMBEDDING_UNAVAILABLE", `Embedding endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}.`, { retryable: true })
  }
  const declaredBytes = Number(response.headers?.get?.("content-length"))
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_EMBEDDING_RESPONSE_BYTES) {
    clearTimeout(timeout)
    throw new LlmWikiError("EMBEDDING_INVALID_RESPONSE", "Embedding endpoint response is too large.", { retryable: true })
  }
  let payload
  try {
    const text = await readBoundedResponseText(response, MAX_EMBEDDING_RESPONSE_BYTES)
    payload = JSON.parse(text)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new LlmWikiError("EMBEDDING_UNAVAILABLE", "Embedding response timed out.", { retryable: true })
    }
    if (error instanceof LlmWikiError) throw error
    throw new LlmWikiError("EMBEDDING_INVALID_RESPONSE", "Embedding endpoint did not return JSON.", { retryable: true })
  } finally {
    clearTimeout(timeout)
  }
  let vectors
  if (config.provider === "ollama") {
    vectors = payload?.embeddings
  } else {
    const data = Array.isArray(payload?.data) ? payload.data : []
    const ordered = new Array(inputs.length)
    const seenIndexes = new Set()
    for (const item of data) {
      const index = Number(item?.index)
      if (!Number.isInteger(index) || index < 0 || index >= inputs.length || seenIndexes.has(index)) {
        throw new LlmWikiError("EMBEDDING_INVALID_RESPONSE", "Embedding endpoint returned duplicate or out-of-range vector indexes.", { retryable: true })
      }
      seenIndexes.add(index)
      ordered[index] = item.embedding
    }
    if (seenIndexes.size !== inputs.length || ordered.some((item) => item === undefined)) {
      throw new LlmWikiError("EMBEDDING_INVALID_RESPONSE", "Embedding endpoint did not return a complete indexed vector set.", { retryable: true })
    }
    vectors = ordered
  }
  if (!Array.isArray(vectors) || vectors.length !== inputs.length) {
    throw new LlmWikiError("EMBEDDING_INVALID_RESPONSE", "Embedding endpoint returned the wrong number of vectors.", { retryable: true })
  }
  let dimensions
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0 || vector.length > MAX_EMBEDDING_DIMENSIONS || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new LlmWikiError("EMBEDDING_INVALID_RESPONSE", "Embedding endpoint returned an invalid vector.", { retryable: true })
    }
    dimensions ??= vector.length
    if (vector.length !== dimensions) throw new LlmWikiError("EMBEDDING_INVALID_RESPONSE", "Embedding vectors have inconsistent dimensions.", { retryable: true })
  }
  return vectors
}

async function readBoundedResponseText(response, maximumBytes) {
  if (!response.body?.getReader) {
    // A response.text() fallback reads the entire body before this function
    // can enforce the byte budget. Native fetch provides a stream; custom
    // adapters must do the same or fail closed.
    throw new LlmWikiError("EMBEDDING_INVALID_RESPONSE", "Embedding endpoint returned a non-streaming response body.", { retryable: true })
  }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    bytes += chunk.byteLength
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => {})
      throw responseTooLarge()
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes).toString("utf8")
}

function responseTooLarge() {
  return new LlmWikiError("EMBEDDING_INVALID_RESPONSE", "Embedding endpoint response is too large.", { retryable: true })
}

async function readCachedVector(root, hash) {
  const file = cachePath(root, hash)
  if (!(await pathExists(file))) return null
  try {
    const value = await readJson(file)
    const valid = value.documentHash === hash
      && Array.isArray(value.vector)
      && value.vector.length > 0
      && value.vector.length <= MAX_EMBEDDING_DIMENSIONS
      && value.vector.every((item) => typeof item === "number" && Number.isFinite(item))
    if (!valid) return null
    // mtime is the small, bounded LRU signal. It avoids rewriting every JSON
    // entry on a read while still allowing old fingerprints to be collected.
    await utimes(file, new Date(), new Date()).catch(() => {})
    return value.vector
  } catch {
    return null
  }
}

async function writeCachedVector(root, hash, vector, config) {
  const file = cachePath(root, hash)
  await ensureDir(path.dirname(file))
  await writeJsonAtomic(file, {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    provider: config.provider,
    model: config.model,
    documentHash: hash,
    dimensions: vector.length,
    vector,
  })
}

async function pruneEmbeddingCache(embeddingRoot, activeRoot, protectedHashes, config) {
  await ensureDir(embeddingRoot)
  let release
  try {
    release = await acquireProcessFileLock(path.join(embeddingRoot, "gc.lock"), { kind: "embedding-cache-gc" }, { waitMs: 0 })
  } catch {
    // Another process is writing or collecting the cache. It is safer to
    // leave excess entries for the next maintenance pass than to race it.
    return { skipped: true, removedFiles: 0, removedBytes: 0 }
  }
  try {
    const files = await embeddingCacheFiles(embeddingRoot)
    const protectedRoot = path.resolve(activeRoot)
    const protectedSet = new Set(protectedHashes)
    const now = Date.now()
    const entries = files.map((entry) => ({
      ...entry,
      protected: path.resolve(entry.file).startsWith(`${protectedRoot}${path.sep}`) && protectedSet.has(entry.hash),
      fresh: now - entry.mtimeMs < CACHE_GC_GRACE_MS,
    }))
    let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    let totalFiles = entries.length
    const removed = []
    const removeEntry = async (entry) => {
      await rm(entry.file, { force: true })
      totalBytes -= entry.bytes
      totalFiles -= 1
      removed.push(entry)
    }
    // Expired, unreachable entries are removed first. Protected entries and
    // recently written entries are never selected by GC.
    for (const entry of entries
      .filter((candidate) => !candidate.protected && !candidate.fresh && now - candidate.mtimeMs >= config.cacheTtlDays * 86_400_000)
      .sort((left, right) => left.mtimeMs - right.mtimeMs)) await removeEntry(entry)
    for (const entry of entries
      .filter((candidate) => !removed.includes(candidate) && !candidate.protected && !candidate.fresh)
      .sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (totalBytes <= config.maxCacheBytes && totalFiles <= config.maxCacheFiles) break
      await removeEntry(entry)
    }
    return {
      skipped: false,
      removedFiles: removed.length,
      removedBytes: removed.reduce((sum, entry) => sum + entry.bytes, 0),
      overBudget: totalBytes > config.maxCacheBytes || totalFiles > config.maxCacheFiles,
    }
  } finally {
    await release?.().catch(() => {})
  }
}

async function embeddingCacheFiles(root) {
  const files = []
  const fingerprints = await readdir(root, { withFileTypes: true })
  for (const fingerprint of fingerprints) {
    if (!fingerprint.isDirectory() || fingerprint.name === "gc.lock" || !/^[a-f0-9]{8,64}$/i.test(fingerprint.name)) continue
    const prefixes = await readdir(path.join(root, fingerprint.name), { withFileTypes: true }).catch(() => [])
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/i.test(prefix.name)) continue
      const entries = await readdir(path.join(root, fingerprint.name, prefix.name), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/i.test(entry.name)) continue
        const file = path.join(root, fingerprint.name, prefix.name, entry.name)
        const info = await stat(file).catch(() => null)
        if (!info?.isFile()) continue
        files.push({ file, hash: entry.name.slice(0, -5), bytes: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
  return files
}

function cachePath(root, hash) {
  return path.join(root, hash.slice(0, 2), `${hash}.json`)
}

function boundedEmbeddingText(document, maxChars) {
  return `${document.title}\n${document.content}`.slice(0, maxChars)
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm > 0 ? vector.map((value) => value / norm) : [...vector]
}

function defaultEndpoint(provider) {
  if (provider === "ollama") return "http://127.0.0.1:11434/api/embed"
  return ""
}

function publicConfig(config) {
  return {
    provider: config.provider,
    model: config.model || null,
    endpoint_configured: Boolean(config.endpoint),
    max_documents: config.maxDocuments,
    total_timeout_ms: config.totalTimeoutMs,
    max_cache_bytes: config.maxCacheBytes,
    max_cache_files: config.maxCacheFiles,
    cache_ttl_days: config.cacheTtlDays,
  }
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback
}

function chunkArray(values, size) {
  const groups = []
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size))
  return groups
}
