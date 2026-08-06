import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { embedQueryAndDocuments, warmEmbeddingCache } from "./embedding.js"
import { listFilesRecursive, readJson, relativePosix, sha256, tokenize } from "./utils.js"

const DEFAULT_RRF_K = 60
const VECTOR_DIMENSIONS = 256
const WIKI_SECTION_CHARS = 4_000
const ANALYSIS_SECTION_CHARS = 4_000
const MAX_RETRIEVAL_DOCUMENTS = 10_000
const MAX_QUERY_CHARS = 10_000

export async function retrieveContext(workspace, taskRecord, queries, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100)
  const maxChars = Math.min(Math.max(Number(options.maxChars) || 60_000, 1_000), 120_000)
  const completedKnowledgeBase = taskRecord.task.status === "completed"
  const channelRequest = canonicalChannels(options.channels, completedKnowledgeBase)
  const requested = channelRequest.canonical
  const query = queries.join("\n")
  if (query.length > MAX_QUERY_CHARS) throw new TypeError(`Combined retrieval query exceeds ${MAX_QUERY_CHARS} characters.`)
  const queryTerms = [...new Set(lexicalTokens(query))]
  const corpus = await retrievalDocuments(workspace, taskRecord, options.currentBatchId)
  const documents = corpus.documents
  const rankings = {}
  const channelStatus = {}

  if (requested.has("bm25")) {
    rankings.bm25 = scoreBm25(documents, queryTerms)
    channelStatus.bm25 = { mode: "lexical", documents: documents.length }
  }
  const wikiRanking = requested.has("wiki") || requested.has("embedding")
    ? scoreWiki(documents, queryTerms, rankings.bm25 ?? [])
    : []
  if (requested.has("wiki")) {
    rankings.wiki = wikiRanking
    channelStatus.wiki = { mode: "wiki-title-link-graph", documents: documents.filter((item) => item.kind === "wiki-page").length }
  }
  if (requested.has("embedding")) {
    const candidates = selectEmbeddingCandidates(documents, rankings.bm25 ?? [], wikiRanking)
    const embedded = await embedQueryAndDocuments(workspace, query, candidates)
    if (embedded.available) {
      rankings.embedding = scoreEmbeddingVectors(documents, embedded.queryVector, embedded.vectors)
      channelStatus.embedding = {
        mode: "embedding",
        ...embedded.config,
        indexed_documents: embedded.indexedDocuments,
        skipped_documents: embedded.skippedDocuments,
        cache_hits: embedded.cacheHits,
      }
    } else {
      rankings.embedding = scoreFeatureHashCandidates(documents, candidates, query)
      channelStatus.embedding = {
        mode: "feature-hash-fallback",
        degraded: true,
        reason: embedded.reason,
        ...embedded.config,
        candidate_documents: candidates.length,
      }
    }
  }

  const fused = fuseRankings(documents, rankings, Number(workspace.config.retrieval?.rrfK) || DEFAULT_RRF_K)
  const hits = []
  const pathUses = new Map()
  let usedChars = 0
  let truncated = false
  for (const item of fused) {
    if (hits.length >= limit) break
    const pathCount = pathUses.get(item.document.path) ?? 0
    if (pathCount >= 2) continue
    const snippet = buildSnippet(item.document.content, queryTerms, 900)
    if (usedChars + snippet.length > maxChars) {
      truncated = true
      break
    }
    usedChars += snippet.length
    pathUses.set(item.document.path, pathCount + 1)
    hits.push({
      kind: item.document.kind,
      path: item.document.path,
      title: item.document.title,
      snippet,
      score: item.score,
      scores: item.scores,
      file_hash: item.document.hash,
      ...(item.document.sourceId ? { source_id: item.document.sourceId } : {}),
      ...(item.document.chunkId ? { chunk_id: item.document.chunkId } : {}),
      ...(item.document.locator ? { locator: item.document.locator } : {}),
      ...(item.document.view ? { view: item.document.view } : {}),
      ...(item.document.section !== undefined ? { section: item.document.section } : {}),
    })
  }
  const available = Object.keys(rankings)
  const availableLabels = channelRequest.labels.filter((label) => available.includes(channelAlias(label)))
  return {
    hits,
    retrieval_phase: completedKnowledgeBase ? "knowledge-base-complete" : "building",
    fusion: "rrf",
    fusion_details: { k: Number(workspace.config.retrieval?.rrfK) || DEFAULT_RRF_K, channels: available },
    wiki_revision: workspace.revision,
    truncated,
    available_channels: availableLabels,
    pending_channels: channelRequest.labels.filter((label) => !available.includes(channelAlias(label))),
    channel_status: channelStatus,
    corpus: corpus.stats,
  }
}

async function retrievalDocuments(workspace, taskRecord, currentBatchId) {
  const maximumDocuments = clampInteger(workspace.config.retrieval?.maxDocuments, 100, MAX_RETRIEVAL_DOCUMENTS, MAX_RETRIEVAL_DOCUMENTS)
  const provisionalPaths = await workspaceProvisionalPaths(workspace, taskRecord.task)
  const wikiResult = await wikiDocuments(workspace, maximumDocuments, provisionalPaths)
  const wiki = wikiResult.documents
  const analyses = []
  let analysisTruncated = false
  for (const [batchIndex, batchId] of taskRecord.task.completedBatchIds.entries()) {
    if (analyses.length >= maximumDocuments) {
      analysisTruncated = batchIndex < taskRecord.task.completedBatchIds.length
      break
    }
    const analysis = await readJson(path.join(taskRecord.paths.analysis, `${batchId}.json`))
    const content = analysisContent(analysis)
    const sections = splitSections(content, ANALYSIS_SECTION_CHARS)
    for (const [index, section] of sections.entries()) {
      if (analyses.length >= maximumDocuments) {
        analysisTruncated = true
        break
      }
      analyses.push(makeDocument({
        id: `analysis:${taskRecord.task.taskId}:${batchId}:${index}`,
        kind: "analysis",
        path: `${taskRecord.task.taskId}/${batchId}`,
        title: analysis.batchSummary || batchId,
        content: section,
        section: index,
      }))
    }
  }
  const current = []
  const sources = []
  let currentTotal = 0
  let sourcesTotal = 0
  for (const batch of taskRecord.batches) {
    for (const chunk of batch.chunks) {
      const isCurrent = batch.batchId === currentBatchId
      const sourceDocuments = spreadsheetChunkDocuments(chunk)
      if (isCurrent) currentTotal += sourceDocuments.length
      else sourcesTotal += sourceDocuments.length
      const target = isCurrent ? current : sources
      for (const document of sourceDocuments) {
        if (target.length >= maximumDocuments) break
        target.push(document)
      }
    }
  }
  const all = fairTake([current, wiki, analyses, sources], maximumDocuments)
  const observedTotal = currentTotal + sourcesTotal + wiki.length + analyses.length
  const preTruncated = wikiResult.truncated || analysisTruncated || current.length < currentTotal || sources.length < sourcesTotal
  return {
    documents: all,
    stats: {
      indexed_documents: all.length,
      total_documents: observedTotal,
      total_documents_exact: !preTruncated,
      max_documents: maximumDocuments,
      truncated: preTruncated || all.length < current.length + wiki.length + analyses.length + sources.length,
      by_kind: countKinds(all),
    },
  }
}

async function workspaceProvisionalPaths(workspace, currentTask) {
  const paths = new Set(Array.isArray(currentTask.pageProjection?.provisionalPagePaths)
    ? currentTask.pageProjection.provisionalPagePaths : [])
  let entries = []
  try {
    entries = await readdir(workspace.paths.tasks, { withFileTypes: true })
  } catch {
    return paths
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("task-") || entry.name === currentTask.taskId) continue
    try {
      const task = await readJson(path.join(workspace.paths.tasks, entry.name, "task.json"))
      for (const provisionalPath of task.pageProjection?.provisionalPagePaths ?? []) paths.add(provisionalPath)
    } catch {
      // A corrupt or concurrently replaced task record cannot make retrieval
      // fail; its pages simply keep their normal deterministic ranking.
    }
  }
  return paths
}

async function wikiDocuments(workspace, limit = MAX_RETRIEVAL_DOCUMENTS, excludedPaths = new Set()) {
  const documents = []
  const files = await listFilesRecursive(workspace.paths.wiki, (candidate) => candidate.endsWith(".md"))
  let truncated = false
  for (const [fileIndex, file] of files.entries()) {
    const relative = `wiki/${relativePosix(workspace.paths.wiki, file)}`
    if (excludedPaths.has(relative)) continue
    if (documents.length >= limit) {
      truncated = fileIndex < files.length
      break
    }
    const content = await readFile(file, "utf8")
    const title = extractTitle(content, path.basename(file, ".md"))
    const sections = splitSections(content, WIKI_SECTION_CHARS)
    for (const [index, section] of sections.entries()) {
      if (documents.length >= limit) {
        truncated = true
        break
      }
      documents.push(makeDocument({
        id: `wiki:${relative}:${index}`,
        kind: "wiki-page",
        path: relative,
        title,
        content: section,
        section: index,
      }))
    }
  }
  return { documents, truncated }
}

function scoreBm25(documents, queryTerms) {
  if (queryTerms.length === 0 || documents.length === 0) return []
  const documentTerms = documents.map((document) => lexicalTokens(document.content))
  const documentFrequency = new Map()
  for (const terms of documentTerms) for (const term of new Set(terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  const averageLength = documentTerms.reduce((sum, terms) => sum + terms.length, 0) / Math.max(1, documents.length)
  return documents.map((document, index) => {
    const terms = documentTerms[index]
    const frequencies = new Map()
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    let score = 0
    for (const query of queryTerms) {
      const frequency = frequencies.get(query) ?? 0
      if (!frequency) continue
      const df = documentFrequency.get(query) ?? 0
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
      const denominator = frequency + 1.2 * (0.25 + 0.75 * (terms.length / Math.max(1, averageLength)))
      score += idf * ((frequency * 2.2) / denominator)
      if (document.title.toLowerCase().includes(query.toLowerCase())) score += 2
    }
    return { documentIndex: index, score }
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || documents[a.documentIndex].id.localeCompare(documents[b.documentIndex].id))
}

function scoreWiki(documents, queryTerms, seeds) {
  const wikiByPath = new Map()
  documents.forEach((document, index) => {
    if (document.kind !== "wiki-page") return
    const values = wikiByPath.get(document.path) ?? []
    values.push(index)
    wikiByPath.set(document.path, values)
  })
  const pageLookup = new Map()
  for (const [pagePath, indexes] of wikiByPath) {
    const slug = normalizeWikiTarget(pagePath)
    pageLookup.set(slug, indexes)
    pageLookup.set(path.posix.basename(slug), indexes)
  }
  const scores = new Map()
  const graph = new Map()
  const connect = (left, right) => {
    if (left === right) return
    const neighbors = graph.get(left) ?? new Set()
    neighbors.add(right)
    graph.set(left, neighbors)
  }
  documents.forEach((document, sourceIndex) => {
    if (document.kind !== "wiki-page") return
    for (const match of document.content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const normalized = normalizeWikiTarget(match[1])
      const targetIndexes = pageLookup.get(normalized) ?? pageLookup.get(path.posix.basename(normalized)) ?? []
      for (const targetIndex of targetIndexes) {
        connect(sourceIndex, targetIndex)
        connect(targetIndex, sourceIndex)
      }
    }
  })
  documents.forEach((document, index) => {
    if (document.kind !== "wiki-page") return
    const title = document.title.normalize("NFKC").toLowerCase()
    const pagePath = document.path.normalize("NFKC").toLowerCase()
    for (const term of queryTerms) {
      const normalized = term.normalize("NFKC").toLowerCase()
      if (title === normalized) scores.set(index, (scores.get(index) ?? 0) + 12)
      else if (title.includes(normalized)) scores.set(index, (scores.get(index) ?? 0) + 5)
      if (pagePath.includes(normalized)) scores.set(index, (scores.get(index) ?? 0) + 2)
    }
  })
  seeds.filter((seed) => documents[seed.documentIndex]?.kind === "wiki-page").slice(0, 20).forEach((seed, rank) => {
    for (const target of [...(graph.get(seed.documentIndex) ?? [])].slice(0, 20)) {
      scores.set(target, (scores.get(target) ?? 0) + 1 / (rank + 1))
    }
  })
  return [...scores].map(([documentIndex, score]) => ({ documentIndex, score })).sort((a, b) => b.score - a.score || documents[a.documentIndex].id.localeCompare(documents[b.documentIndex].id))
}

function selectEmbeddingCandidates(documents, bm25, wiki) {
  const ordered = []
  const seen = new Set()
  const add = (index) => {
    const document = documents[index]
    if (!document || seen.has(document.id)) return
    seen.add(document.id)
    ordered.push(document)
  }
  bm25.slice(0, 500).forEach((item) => add(item.documentIndex))
  wiki.slice(0, 250).forEach((item) => add(item.documentIndex))
  for (let index = 0; index < documents.length && ordered.length < 2_000; index += 1) add(index)
  return ordered
}

function scoreEmbeddingVectors(documents, queryVector, vectors) {
  return documents.map((document, documentIndex) => {
    const vector = vectors.get(document.id)
    return vector ? { documentIndex, score: cosine(queryVector, vector) } : null
  }).filter((item) => item && item.score > 0).sort((a, b) => b.score - a.score || documents[a.documentIndex].id.localeCompare(documents[b.documentIndex].id))
}

function scoreFeatureHashCandidates(documents, candidates, query) {
  const indexes = new Map(documents.map((document, index) => [document.id, index]))
  const queryVector = embedText(query)
  return candidates.map((document) => ({ documentIndex: indexes.get(document.id), score: cosine(queryVector, embedText(`${document.title}\n${document.content}`)) }))
    .filter((item) => item.documentIndex !== undefined && item.score > 0)
    .sort((a, b) => b.score - a.score || documents[a.documentIndex].id.localeCompare(documents[b.documentIndex].id))
}

function fuseRankings(documents, rankings, rrfK) {
  const fused = new Map()
  for (const [channel, ranking] of Object.entries(rankings)) {
    ranking.forEach((item, rank) => {
      const current = fused.get(item.documentIndex) ?? { document: documents[item.documentIndex], score: 0, scores: {} }
      current.score += 1 / (rrfK + rank + 1)
      current.scores[channel] = item.score
      current.scores.rrf = current.score
      fused.set(item.documentIndex, current)
    })
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
}

export function embedText(text) {
  const vector = new Array(VECTOR_DIMENSIONS).fill(0)
  const normalized = String(text).normalize("NFKC").toLowerCase()
  const features = [...tokenize(normalized)]
  const characters = Array.from(normalized.replace(/\s+/g, " "))
  for (let index = 0; index < characters.length - 2; index += 1) features.push(characters.slice(index, index + 3).join(""))
  for (const feature of features) {
    const hash = hashFeature(feature)
    vector[hash % VECTOR_DIMENSIONS] += (hash & 0x100) === 0 ? 1 : -1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm > 0 ? vector.map((value) => value / norm) : vector
}

function lexicalTokens(text) {
  const normalized = String(text).normalize("NFKC").toLowerCase()
  const tokens = []
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0]
    if (token.length > 1) tokens.push(token)
    if (/[\u3400-\u9fff]/u.test(token)) {
      const characters = Array.from(token)
      for (let index = 0; index < characters.length - 1; index += 1) tokens.push(`${characters[index]}${characters[index + 1]}`)
    }
  }
  return tokens
}

function hashFeature(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0
  return left.reduce((sum, value, index) => sum + value * right[index], 0)
}

function buildSnippet(content, terms, limit) {
  const lower = content.toLowerCase()
  const positions = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((value) => value >= 0)
  const center = positions.length > 0 ? Math.min(...positions) : 0
  const start = Math.max(0, center - Math.floor(limit / 3))
  const snippet = content.slice(start, start + limit).trim()
  return `${start > 0 ? "…" : ""}${snippet}${start + limit < content.length ? "…" : ""}`
}

function analysisContent(analysis) {
  const lines = [analysis.batchSummary, ...(analysis.unresolvedQuestions ?? [])]
  for (const collection of ["entities", "concepts", "claims", "relations", "contradictions", "reviewItems"]) {
    for (const item of analysis[collection] ?? []) {
      lines.push([item.name, item.title, item.text, item.content, item.subject, item.predicate, item.object, item.entityTypeId, item.relationTypeId]
        .filter((value) => typeof value === "string" && value.trim()).join(" "))
      if (item.properties && typeof item.properties === "object") lines.push(JSON.stringify(item.properties))
    }
  }
  return lines.filter(Boolean).join("\n")
}

function splitSections(content, maxChars) {
  const sections = []
  let rest = String(content)
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1)
    const cut = Math.max(window.lastIndexOf("\n## "), window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), Math.floor(maxChars * 0.6))
    sections.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.trim() || sections.length === 0) sections.push(rest.trim())
  return sections.filter(Boolean)
}

function makeDocument(document) {
  return { ...document, hash: sha256(`${document.title}\n${document.content}`) }
}

function spreadsheetChunkDocuments(chunk) {
  const base = makeDocument({
    id: `source:${chunk.sourceId}:${chunk.chunkId}`,
    kind: "source-chunk",
    path: `${chunk.sourceId}/${chunk.chunkId}`,
    title: chunkTitle(chunk),
    content: chunk.text,
    sourceId: chunk.sourceId,
    chunkId: chunk.chunkId,
    locator: chunkLocator(chunk),
    ...(chunk.retrievalViews?.length > 0 ? { view: "excel-block" } : {}),
  })
  if (!Array.isArray(chunk.retrievalViews) || chunk.retrievalViews.length === 0) return [base]
  return [base, ...chunk.retrievalViews.slice(0, 6).map((view, index) => makeDocument({
    id: `source:${chunk.sourceId}:${chunk.chunkId}:view:${view.view ?? index}`,
    kind: "source-structure",
    path: `${chunk.sourceId}/${chunk.chunkId}`,
    title: view.title || `${chunkTitle(chunk)} ${view.view ?? "structure"}`,
    content: view.content || chunk.text,
    sourceId: chunk.sourceId,
    chunkId: chunk.chunkId,
    locator: chunkLocator(chunk),
    view: view.view ?? "excel-structure",
  }))]
}

function chunkTitle(chunk) {
  if (chunk.sheetName && chunk.cellRange) return `${chunk.sheetName} ${chunk.cellRange}`
  return Array.isArray(chunk.headingPath) && chunk.headingPath.length > 0 ? chunk.headingPath.join(" / ") : chunk.chunkId
}

function chunkLocator(chunk) {
  return {
    ...(Array.isArray(chunk.headingPath) ? { headingPath: chunk.headingPath } : {}),
    ...(Number.isInteger(chunk.startOffset) ? { startOffset: chunk.startOffset } : {}),
    ...(Number.isInteger(chunk.endOffset) ? { endOffset: chunk.endOffset } : {}),
    ...(Number.isInteger(chunk.pageNumber) ? { page: chunk.pageNumber } : {}),
    ...(chunk.sheetName ? { sheetName: chunk.sheetName } : {}),
    ...(chunk.cellRange ? { cellRange: chunk.cellRange } : {}),
  }
}

function canonicalChannels(value, completedKnowledgeBase) {
  const defaults = completedKnowledgeBase ? ["bm25", "embedding", "wiki"] : ["bm25", "embedding"]
  const labels = [...new Set(Array.isArray(value) && value.length > 0 ? value : defaults)]
  return { labels, canonical: new Set(labels.map(channelAlias)) }
}

function channelAlias(channel) {
  return channel === "vector" ? "embedding" : channel === "graph" ? "wiki" : channel
}

function fairTake(groups, limit) {
  const result = []
  let index = 0
  while (result.length < limit && groups.some((group) => index < group.length)) {
    for (const group of groups) {
      if (result.length >= limit) break
      if (index < group.length) result.push(group[index])
    }
    index += 1
  }
  return result
}

function countKinds(documents) {
  const counts = {}
  for (const document of documents) counts[document.kind] = (counts[document.kind] ?? 0) + 1
  return counts
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback
}

function extractTitle(content, fallback) {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback
}

function normalizeWikiTarget(value) {
  return value.replace(/\\/g, "/").replace(/^wiki\//i, "").replace(/\.md$/i, "").normalize("NFKC").toLowerCase()
}

export async function buildBm25Index(workspace) {
  const loaded = await wikiDocuments(workspace, configuredDocumentLimit(workspace))
  const pages = loaded.documents
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    truncated: loaded.truncated,
    documents: pages.map((document) => ({ id: document.id, path: document.path, title: document.title, hash: document.hash, length: lexicalTokens(document.content).length })),
  }
}

export async function buildVectorIndex(workspace) {
  const loaded = await wikiDocuments(workspace, configuredDocumentLimit(workspace))
  const pages = loaded.documents
  return {
    schemaVersion: 2,
    kind: "deterministic-feature-hash-fallback",
    generatedAt: new Date().toISOString(),
    truncated: loaded.truncated,
    documents: pages.map((document) => ({ id: document.id, path: document.path, hash: document.hash, dimensions: VECTOR_DIMENSIONS, vector: embedText(document.content) })),
  }
}

export async function buildEmbeddingIndex(workspace) {
  const loaded = await wikiDocuments(workspace, configuredDocumentLimit(workspace))
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), truncated: loaded.truncated, ...(await warmEmbeddingCache(workspace, loaded.documents)) }
}

export async function buildRetrievalIndexes(workspace) {
  const loaded = await wikiDocuments(workspace, configuredDocumentLimit(workspace))
  const pages = loaded.documents
  const generatedAt = new Date().toISOString()
  const embedding = { schemaVersion: 1, generatedAt, truncated: loaded.truncated, ...(await warmEmbeddingCache(workspace, pages)) }
  return {
    bm25: {
      schemaVersion: 2,
      generatedAt,
      truncated: loaded.truncated,
      documents: pages.map((document) => ({ id: document.id, path: document.path, title: document.title, hash: document.hash, length: lexicalTokens(document.content).length })),
    },
    vector: {
      schemaVersion: 2,
      kind: "deterministic-feature-hash-fallback",
      generatedAt,
      truncated: loaded.truncated,
      documents: pages.map((document) => ({ id: document.id, path: document.path, hash: document.hash, dimensions: VECTOR_DIMENSIONS, vector: embedText(document.content) })),
    },
    embedding,
  }
}

function configuredDocumentLimit(workspace) {
  return clampInteger(workspace.config.retrieval?.maxDocuments, 100, MAX_RETRIEVAL_DOCUMENTS, MAX_RETRIEVAL_DOCUMENTS)
}
