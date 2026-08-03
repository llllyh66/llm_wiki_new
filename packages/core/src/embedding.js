import path from "node:path"
import { LlmWikiError } from "./errors.js"
import { ensureDir, pathExists, readJson, sha256, stableStringify, writeJsonAtomic } from "./utils.js"

const MAX_EMBEDDING_DIMENSIONS = 8_192
const MAX_EMBEDDING_BATCH = 32
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_EMBEDDING_RESPONSE_BYTES = 16 * 1024 * 1024
const SUPPORTED_PROVIDERS = new Set(["none", "openai-compatible", "ollama"])

export function resolveEmbeddingConfig(workspace) {
  const configured = workspace.config.retrieval?.embedding ?? {}
  const provider = process.env.LLM_WIKI_EMBEDDING_PROVIDER || configured.provider || "none"
  const model = process.env.LLM_WIKI_EMBEDDING_MODEL || configured.model || ""
  const endpoint = process.env.LLM_WIKI_EMBEDDING_URL || configured.endpoint || defaultEndpoint(provider)
  const batchSize = clampInteger(configured.batchSize, 1, MAX_EMBEDDING_BATCH, 16)
  const timeoutMs = clampInteger(configured.timeoutMs, 1_000, 120_000, DEFAULT_TIMEOUT_MS)
  const totalTimeoutMs = clampInteger(configured.totalTimeoutMs, 5_000, 300_000, 60_000)
  const maxInputChars = clampInteger(configured.maxInputChars, 1_000, 32_000, 8_000)
  const maxDocuments = clampInteger(configured.maxDocuments, 10, 10_000, 1_000)
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
    apiKey: process.env.LLM_WIKI_EMBEDDING_API_KEY || "",
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
  const vectors = config.provider === "ollama"
    ? payload?.embeddings
    : [...(Array.isArray(payload?.data) ? payload.data : [])].sort((left, right) => Number(left.index) - Number(right.index)).map((item) => item.embedding)
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
    const text = await response.text()
    if (Buffer.byteLength(text) > maximumBytes) throw responseTooLarge()
    return text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => {})
      throw responseTooLarge()
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function responseTooLarge() {
  return new LlmWikiError("EMBEDDING_INVALID_RESPONSE", "Embedding endpoint response is too large.", { retryable: true })
}

async function readCachedVector(root, hash) {
  const file = cachePath(root, hash)
  if (!(await pathExists(file))) return null
  try {
    const value = await readJson(file)
    return Array.isArray(value.vector) && value.vector.length > 0 && value.vector.length <= MAX_EMBEDDING_DIMENSIONS
      && value.vector.every((item) => typeof item === "number" && Number.isFinite(item))
      ? value.vector
      : null
  } catch {
    return null
  }
}

async function writeCachedVector(root, hash, vector, config) {
  const file = cachePath(root, hash)
  await ensureDir(path.dirname(file))
  await writeJsonAtomic(file, {
    schemaVersion: 1,
    provider: config.provider,
    model: config.model,
    documentHash: hash,
    dimensions: vector.length,
    vector,
  })
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
