import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { buildEmbeddingSnapshot, embedQueryFromCache, warmEmbeddingCache } from "./embedding.js"
import { listFilesRecursive, pathExists, readJson, relativePosix, safeTextCut, sha256, tokenize, writeBufferAtomic, writeJsonAtomic } from "./utils.js"
import { extractWikiLinks } from "./wiki-page.js"

const DEFAULT_RRF_K = 60
const VECTOR_DIMENSIONS = 256
const WIKI_SECTION_CHARS = 4_000
const ANALYSIS_SECTION_CHARS = 4_000
const MAX_RETRIEVAL_DOCUMENTS = Number.MAX_SAFE_INTEGER
const MAX_QUERY_CHARS = 10_000

export async function retrieveContext(workspace, taskRecord, queries, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100)
  const maxChars = Math.min(Math.max(Number(options.maxChars) || 60_000, 1_000), 120_000)
  const publication = await retrievalPublicationState(workspace, taskRecord.task)
  const completedKnowledgeBase = publication.published
  const channelRequest = canonicalChannels(options.channels, completedKnowledgeBase)
  const requested = channelRequest.canonical
  const query = queries.join("\n")
  if (query.length > MAX_QUERY_CHARS) throw new TypeError(`Combined retrieval query exceeds ${MAX_QUERY_CHARS} characters.`)
  const queryTerms = [...new Set(lexicalTokens(query))]
  const corpus = await retrievalDocuments(workspace, taskRecord, options.currentBatchId)
  const documents = corpus.documents
  const taskIndex = completedKnowledgeBase ? null : await readJson(taskRecord.paths.retrievalIndex, null)
  const persistedBm25 = completedKnowledgeBase ? await activeRetrievalArtifact(workspace, "bm25.json") : taskIndex?.bm25 ?? null
  const persistedVectors = completedKnowledgeBase
    ? await activeFloatVectorArtifact(workspace, "feature-hash.json", false)
    : await taskFeatureHashArtifact(taskRecord, taskIndex?.featureHash)
  const persistedEmbedding = completedKnowledgeBase ? await activeEmbeddingArtifact(workspace) : null
  const rankings = {}
  const channelStatus = {}
  const embeddingIndexedDocumentIds = new Set()

  if (requested.has("bm25")) {
    rankings.bm25 = persistedBm25
      ? scoreBm25WithPersistedWiki(documents, queryTerms, persistedBm25)
      : scoreBm25(documents, queryTerms)
    channelStatus.bm25 = { mode: persistedBm25 ? "persisted-inverted-index" : "task-local-lexical", documents: documents.length }
  }
  const wikiAvailable = requested.has("wiki") && documents.some((document) => document.kind === "wiki-page")
  const wikiRanking = wikiAvailable
    ? scoreWiki(documents, queryTerms, rankings.bm25 ?? [])
    : []
  if (wikiAvailable) {
    rankings.wiki = wikiRanking
    channelStatus.wiki = { mode: "wiki-title-link-graph", documents: documents.filter((item) => item.kind === "wiki-page").length }
  }
  if (requested.has("embedding")) {
    const candidates = selectEmbeddingCandidates(documents, rankings.bm25 ?? [], wikiRanking, completedKnowledgeBase)
    const publishedVectors = new Map((persistedEmbedding?.documents ?? []).map((meta, index) => [meta.id, persistedEmbedding.vectors?.[index]]))
    const embedded = await embedQueryFromCache(workspace, query, candidates, publishedVectors)
    if (embedded.available) {
      const vectors = new Map(embedded.vectors)
      for (const [index, meta] of (persistedEmbedding?.documents ?? []).entries()) {
        const vector = persistedEmbedding.vectors?.[index]
        if (Array.isArray(vector) || ArrayBuffer.isView(vector)) vectors.set(meta.id, vector)
      }
      rankings.embedding = scoreEmbeddingVectors(documents, embedded.queryVector, vectors)
      for (const documentId of vectors.keys()) embeddingIndexedDocumentIds.add(documentId)
      channelStatus.embedding = {
        mode: "embedding",
        ...embedded.config,
        indexed_documents: embedded.indexedDocuments,
        skipped_documents: embedded.skippedDocuments,
        cache_hits: embedded.cacheHits,
      }
    } else {
      rankings.feature_hash = persistedVectors
        ? scoreFeatureHashWithPersistedWiki(documents, candidates, query, persistedVectors)
        : scoreFeatureHashCandidates(documents, candidates, query)
      channelStatus.feature_hash = {
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
  const seenEvidence = new Set()
  const perPathLimit = clampInteger(workspace.config.retrieval?.maxSectionsPerPath, 1, 20, 6)
  let usedChars = 0
  let truncated = false
  for (const item of fused) {
    if (hits.length >= limit) break
    const pathCount = pathUses.get(item.document.path) ?? 0
    if (pathCount >= perPathLimit) continue
    const evidenceKey = `${item.document.path}:${sha256(item.document.content.normalize("NFKC").replace(/\s+/g, " ").trim())}`
    if (seenEvidence.has(evidenceKey)) continue
    const snippet = buildSnippet(item.document.content, queryTerms, 900)
    if (usedChars + snippet.length > maxChars) {
      truncated = true
      break
    }
    usedChars += snippet.length
    pathUses.set(item.document.path, pathCount + 1)
    seenEvidence.add(evidenceKey)
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
      ...(item.document.section !== undefined ? { section: item.document.section } : {}),
    })
  }
  const available = Object.keys(rankings)
  const availableLabels = channelRequest.labels.filter((label) => available.includes(label))
  const pendingLabels = channelRequest.labels.filter((label) => !available.includes(label))
  const sourceDocuments = documents.filter((document) => document.kind === "source-chunk")
  const sourceReadiness = taskRecord.task.sourceIds.map((sourceId) => {
    const sourceChunks = sourceDocuments.filter((document) => document.sourceId === sourceId)
    const embeddingChunks = sourceChunks.filter((document) => embeddingIndexedDocumentIds.has(document.id)).length
    return {
      source_id: sourceId,
      parsed: sourceChunks.length > 0,
      chunk_count: sourceChunks.length,
      bm25_indexed_chunks: sourceChunks.length,
      embedding_indexed_chunks: embeddingChunks,
      embedding_complete: sourceChunks.length > 0 && embeddingChunks === sourceChunks.length,
    }
  })
  return {
    hits,
    retrieval_phase: publication.phase,
    fusion: "rrf",
    fusion_details: { k: Number(workspace.config.retrieval?.rrfK) || DEFAULT_RRF_K, channels: available },
    wiki_revision: workspace.revision,
    truncated,
    available_channels: availableLabels,
    pending_channels: pendingLabels,
    fallback_channels: available.includes("feature_hash") ? ["feature_hash"] : [],
    requested_channels: channelRequest.labels,
    effective_channels: available,
    channel_status: channelStatus,
    corpus: corpus.stats,
    answer_scope: completedKnowledgeBase ? "published-generation" : "task-local-ready-sources",
    retrieval_readiness: {
      state: publication.phase,
      manifest_generation: publication.generationId,
      sources: {
        accepted: taskRecord.task.sourceIds.length,
        parsed: taskRecord.task.sourceIds.length,
        bm25_indexed: new Set(sourceDocuments.map((document) => document.sourceId)).size,
        embedding_indexed_documents: channelStatus.embedding?.indexed_documents ?? 0,
        failed: 0,
        by_source: sourceReadiness,
      },
      channels: {
        bm25: { indexed: documents.length, total: corpus.stats.total_documents, complete: !corpus.stats.truncated },
        embedding: {
          indexed: channelStatus.embedding?.indexed_documents ?? 0,
          total: candidatesForStatus(requested, documents.length),
          complete: Boolean(channelStatus.embedding && channelStatus.embedding.skipped_documents === 0),
          degraded: !channelStatus.embedding,
        },
      },
    },
  }
}

function candidatesForStatus(requested, total) {
  return requested.has("embedding") ? total : 0
}

async function retrievalDocuments(workspace, taskRecord, currentBatchId) {
  // maxDocuments is retained as an index-shard tuning hint, never as a
  // semantic corpus cutoff. All ready documents participate in retrieval.
  const maximumDocuments = MAX_RETRIEVAL_DOCUMENTS
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
      if (isCurrent) currentTotal += 1
      else sourcesTotal += 1
      const target = isCurrent ? current : sources
      if (target.length >= maximumDocuments) continue
      target.push(makeDocument({
        id: `source:${chunk.sourceId}:${chunk.chunkId}`,
        kind: "source-chunk",
        path: `${chunk.sourceId}/${chunk.chunkId}`,
        title: chunkTitle(chunk),
        content: chunk.text,
        sourceId: chunk.sourceId,
        chunkId: chunk.chunkId,
        locator: chunkLocator(chunk),
      }))
    }
  }
  // During build, uploaded task-local evidence has a hard priority guarantee.
  // A previous stable Wiki is auxiliary context and cannot consume the source
  // quota before every ready source/analysis document participates.
  const all = taskRecord.task.status === "completed"
    ? fairTake([current, sources, analyses, wiki], maximumDocuments)
    : [...current, ...sources, ...analyses, ...wiki].slice(0, maximumDocuments)
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
      // Fail closed: if ownership cannot be proven, the mutable workspace Wiki
      // is not a safe retrieval source.  Active-generation reads do not need
      // this set, but keeping a sentinel excludes all worktree pages on the
      // compatibility path.
      paths.add("*")
    }
  }
  return paths
}

async function wikiDocuments(workspace, limit = MAX_RETRIEVAL_DOCUMENTS, excludedPaths = new Set(), options = {}) {
  const documents = []
  const wikiRoot = options.wikiRoot ?? await activeWikiRoot(workspace)
  if (!wikiRoot) return { documents, truncated: false }
  const files = await listFilesRecursive(wikiRoot, (candidate) => candidate.endsWith(".md"))
  let truncated = false
  for (const [fileIndex, file] of files.entries()) {
    const relative = `wiki/${relativePosix(wikiRoot, file)}`
    if (excludedPaths.has("*") || excludedPaths.has(relative)) continue
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

async function activeWikiRoot(workspace) {
  const pointer = await readJson(workspace.paths.currentGeneration, null)
  const generationId = pointer?.generation_id
  if (typeof generationId !== "string" || !/^generation-[0-9a-f-]+$/i.test(generationId)) return null
  const generationWikiRoot = path.join(workspace.paths.generations, generationId, "wiki")
  return await pathExists(generationWikiRoot) ? generationWikiRoot : null
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
    for (const link of extractWikiLinks(document.content)) {
      const normalized = normalizeWikiTarget(link)
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

function selectEmbeddingCandidates(documents, bm25, wiki, completedKnowledgeBase) {
  const ordered = []
  const seen = new Set()
  const add = (index) => {
    const document = documents[index]
    if (!document || seen.has(document.id)) return
    seen.add(document.id)
    ordered.push(document)
  }
  if (!completedKnowledgeBase) {
    documents.forEach((document, index) => {
      if (document.kind === "source-chunk" || document.kind === "analysis") add(index)
    })
  }
  bm25.forEach((item) => add(item.documentIndex))
  wiki.forEach((item) => add(item.documentIndex))
  for (let index = 0; index < documents.length; index += 1) add(index)
  return ordered
}

async function retrievalPublicationState(workspace, task) {
  const pointer = await readJson(workspace.paths.currentGeneration, null)
  const generationId = typeof pointer?.generation_id === "string" ? pointer.generation_id : null
  if (task.status !== "completed") {
    return { published: false, phase: task.status === "importing" || task.status === "parsing" ? "importing" : "source-ready", generationId }
  }
  if (!generationId) {
    return { published: false, phase: "degraded", generationId }
  }
  const manifest = await readJson(path.join(workspace.paths.generations, generationId, "manifest.json"), null)
  if (!manifest || manifest.generationId !== generationId) {
    return { published: false, phase: "degraded", generationId }
  }
  return { published: true, phase: "knowledge-base-complete", generationId }
}

async function activeRetrievalArtifact(workspace, name) {
  const pointer = await readJson(workspace.paths.currentGeneration, null)
  const generationId = pointer?.generation_id
  if (typeof generationId !== "string" || !/^generation-[0-9a-f-]+$/i.test(generationId)) return null
  const root = path.join(workspace.paths.generations, generationId)
  const manifest = await readJson(path.join(root, "manifest.json"), null)
  const descriptor = manifest?.artifacts?.[name]
  if (!descriptor || descriptor.path !== name || typeof descriptor.sha256 !== "string") return null
  const artifactPath = path.join(root, name)
  try {
    const text = await readFile(artifactPath, "utf8")
    if (sha256(text) !== descriptor.sha256) throw new Error("artifact hash mismatch")
    return JSON.parse(text)
  } catch (error) {
    const failure = new Error(`Published retrieval artifact ${name} is missing or corrupt: ${error instanceof Error ? error.message : String(error)}`)
    failure.code = "RETRIEVAL_INDEX_INCOMPLETE"
    throw failure
  }
}

async function activeEmbeddingArtifact(workspace) {
  return activeFloatVectorArtifact(workspace, "embedding.json", true)
}

async function activeFloatVectorArtifact(workspace, metadataName, decodeVectors) {
  const metadata = await activeRetrievalArtifact(workspace, metadataName)
  if (!metadata || metadata.documents?.length === 0 || (decodeVectors && metadata.status !== "completed")) return metadata
  const pointer = await readJson(workspace.paths.currentGeneration, null)
  const generationId = pointer?.generation_id
  const root = path.join(workspace.paths.generations, generationId)
  const manifest = await readJson(path.join(root, "manifest.json"), null)
  const descriptor = manifest?.artifacts?.[metadata.vector_path]
  if (!descriptor || descriptor.path !== metadata.vector_path || typeof descriptor.sha256 !== "string") {
    throw retrievalIndexFailure("Published embedding vector descriptor is missing.")
  }
  const bytes = await readFile(path.join(root, metadata.vector_path))
  if (sha256(bytes) !== descriptor.sha256) throw retrievalIndexFailure("Published embedding vector hash mismatch.")
  const dimensions = Number(metadata.dimensions) || 0
  const expectedBytes = metadata.documents.length * dimensions * 4
  if (dimensions < 1 || bytes.byteLength !== expectedBytes) throw retrievalIndexFailure("Published embedding vector dimensions are inconsistent.")
  if (!decodeVectors) return { ...metadata, vectorBytes: bytes }
  const vectors = []
  for (let documentIndex = 0; documentIndex < metadata.documents.length; documentIndex += 1) {
    const vector = new Float32Array(dimensions)
    const offset = documentIndex * dimensions * 4
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      vector[dimension] = bytes.readFloatLE(offset + dimension * 4)
    }
    vectors.push(vector)
  }
  return { ...metadata, vectors }
}

function retrievalIndexFailure(message) {
  const failure = new Error(message)
  failure.code = "RETRIEVAL_INDEX_INCOMPLETE"
  return failure
}

function scoreBm25WithPersistedWiki(documents, queryTerms, index) {
  const wikiById = new Map(documents.map((document, documentIndex) => [document.id, documentIndex]))
  const scores = new Map()
  const count = Number(index.documentCount) || 0
  const averageLength = Number(index.averageDocumentLength) || 1
  for (const term of queryTerms) {
    const posting = index.postings?.[term]
    if (!posting || !Array.isArray(posting.docs)) continue
    const df = posting.docs.length
    const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5))
    for (const [storedIndex, frequency] of posting.docs) {
      const meta = index.documents?.[storedIndex]
      const documentIndex = meta ? wikiById.get(meta.id) : undefined
      if (documentIndex === undefined || !Number.isFinite(frequency)) continue
      const length = Number(index.lengths?.[storedIndex]) || 1
      const denominator = frequency + 1.2 * (0.25 + 0.75 * (length / Math.max(1, averageLength)))
      scores.set(documentIndex, (scores.get(documentIndex) ?? 0) + idf * ((frequency * 2.2) / denominator))
    }
  }
  const persistedIds = new Set((index.documents ?? []).map((document) => document.id))
  const liveDocuments = documents.map((document, indexValue) => ({ document, indexValue })).filter(({ document }) => !persistedIds.has(document.id))
  const liveRanking = scoreBm25(liveDocuments.map(({ document }) => document), queryTerms)
  for (const item of liveRanking) scores.set(liveDocuments[item.documentIndex].indexValue, item.score)
  return [...scores].map(([documentIndex, score]) => ({ documentIndex, score }))
    .sort((left, right) => right.score - left.score || documents[left.documentIndex].id.localeCompare(documents[right.documentIndex].id))
}

function scoreFeatureHashWithPersistedWiki(documents, candidates, query, index) {
  const queryVector = embedText(query)
  const candidateIds = new Set(candidates.map((document) => document.id))
  const documentIndexes = new Map(documents.map((document, documentIndex) => [document.id, documentIndex]))
  const scores = []
  for (const [storedIndex, meta] of (index.documents ?? []).entries()) {
    if (!candidateIds.has(meta.id)) continue
    const vector = storedVector(index, storedIndex)
    const documentIndex = documentIndexes.get(meta.id)
    if (documentIndex === undefined || !Array.isArray(vector)) continue
    const score = cosine(queryVector, vector)
    if (score > 0) scores.push({ documentIndex, score })
  }
  const persistedIds = new Set((index.documents ?? []).map((document) => document.id))
  const liveCandidates = candidates.filter((document) => !persistedIds.has(document.id))
  scores.push(...scoreFeatureHashCandidates(documents, liveCandidates, query))
  return scores.sort((left, right) => right.score - left.score || documents[left.documentIndex].id.localeCompare(documents[right.documentIndex].id))
}

function storedVector(index, storedIndex) {
  const inline = index.vectors?.[storedIndex]
  if (Array.isArray(inline) || ArrayBuffer.isView(inline)) return inline
  const dimensions = Number(index.dimensions) || 0
  const bytes = index.vectorBytes
  const offset = storedIndex * dimensions * 4
  if (!Buffer.isBuffer(bytes) || dimensions < 1 || offset + dimensions * 4 > bytes.length) return null
  const vector = new Float32Array(dimensions)
  for (let dimension = 0; dimension < dimensions; dimension += 1) vector[dimension] = bytes.readFloatLE(offset + dimension * 4)
  return vector
}

async function taskFeatureHashArtifact(record, metadata) {
  if (!metadata || metadata.storage !== "contiguous-float32-le") return metadata ?? null
  try {
    const bytes = await readFile(record.paths.featureHashVectors)
    if (sha256(bytes) !== metadata.vectorSha256) throw new Error("hash mismatch")
    if (bytes.length !== Number(metadata.documentCount) * Number(metadata.dimensions) * 4) throw new Error("size mismatch")
    return { ...metadata, vectorBytes: bytes }
  } catch (error) {
    const failure = new Error(`Task feature-hash index is missing or corrupt: ${error instanceof Error ? error.message : String(error)}`)
    failure.code = "RETRIEVAL_INDEX_INCOMPLETE"
    throw failure
  }
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
  const longTerms = lexicalTokens(query).filter((term) => term.length >= 8)
  return candidates.map((document) => {
    const hasLongTerm = longTerms.length === 0 || longTerms.some((term) => `${document.title}\n${document.content}`.toLowerCase().includes(term))
    if (!hasLongTerm) return null
    return { documentIndex: indexes.get(document.id), score: cosine(queryVector, embedText(`${document.title}\n${document.content}`)) }
  })
    .filter((item) => item && item.documentIndex !== undefined && item.score > 0)
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
      lines.push([item.name, item.title, item.text, item.content, item.subject, item.predicate, item.object]
        .filter((value) => typeof value === "string" && value.trim()).join(" "))
      if (item.properties && typeof item.properties === "object") lines.push(JSON.stringify(item.properties))
      if (item.schemaClassification && typeof item.schemaClassification === "object") lines.push(JSON.stringify(item.schemaClassification))
    }
  }
  return lines.filter(Boolean).join("\n")
}

function splitSections(content, maxChars) {
  const sections = []
  const source = String(content)
  let cursor = 0
  const overlapChars = Math.max(1, Math.floor(maxChars * 0.12))
  while (source.length - cursor > maxChars) {
    const window = source.slice(cursor, cursor + maxChars + 1)
    const relativeCut = Math.max(window.lastIndexOf("\n## "), window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), Math.floor(maxChars * 0.6))
    const cut = safeTextCut(source, cursor + relativeCut, cursor)
    sections.push(source.slice(cursor, cut).trim())
    const next = Math.max(cursor + 1, cut - overlapChars)
    cursor = safeTextCut(source, next, cursor)
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1
  }
  const rest = source.slice(cursor).trim()
  if (rest || sections.length === 0) sections.push(rest)
  return sections.filter(Boolean)
}

function makeDocument(document) {
  return { ...document, hash: sha256(`${document.title}\n${document.content}`) }
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
    ...(Number.isInteger(chunk.slideNumber) ? { slide: chunk.slideNumber } : {}),
    ...(chunk.sheetName ? { sheetName: chunk.sheetName } : {}),
    ...(chunk.cellRange ? { cellRange: chunk.cellRange } : {}),
  }
}

function canonicalChannels(value, completedKnowledgeBase) {
  const defaults = completedKnowledgeBase ? ["bm25", "embedding", "wiki"] : ["bm25", "embedding"]
  const labels = [...new Set(Array.isArray(value) && value.length > 0 ? value : defaults)]
  return { labels, canonical: new Set(labels) }
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
  return persistedBm25Index(loaded.documents, loaded.truncated)
}

export async function buildFeatureHashIndex(workspace, options = {}) {
  const loaded = await wikiDocuments(workspace, configuredDocumentLimit(workspace), new Set(), options)
  const pages = loaded.documents
  return {
    schemaVersion: 3,
    kind: "deterministic-feature-hash-fallback",
    generatedAt: new Date().toISOString(),
    truncated: loaded.truncated,
    dimensions: VECTOR_DIMENSIONS,
    documentCount: pages.length,
    documents: pages.map((document) => ({ id: document.id, path: document.path, hash: document.hash })),
    vectors: pages.map((document) => embedText(document.content)),
  }
}

export async function buildEmbeddingIndex(workspace, options = {}) {
  const loaded = await wikiDocuments(workspace, configuredDocumentLimit(workspace), new Set(), options)
  return { ...(await buildEmbeddingSnapshot(workspace, loaded.documents)), truncated: loaded.truncated }
}

export async function buildRetrievalIndexes(workspace, options = {}) {
  const loaded = await wikiDocuments(workspace, configuredDocumentLimit(workspace), new Set(), options)
  const pages = loaded.documents
  const generatedAt = new Date().toISOString()
  const embedding = { ...(await buildEmbeddingSnapshot(workspace, pages)), generatedAt, truncated: loaded.truncated }
  return {
    bm25: persistedBm25Index(pages, loaded.truncated, generatedAt),
    featureHash: {
      schemaVersion: 3,
      kind: "deterministic-feature-hash-fallback",
      generatedAt,
      truncated: loaded.truncated,
      dimensions: VECTOR_DIMENSIONS,
      documentCount: pages.length,
      documents: pages.map((document) => ({ id: document.id, path: document.path, hash: document.hash })),
      vectors: pages.map((document) => embedText(document.content)),
    },
    embedding,
  }
}

function persistedBm25Index(documents, truncated, generatedAt = new Date().toISOString()) {
  const postings = Object.create(null)
  const lengths = []
  for (const [documentIndex, document] of documents.entries()) {
    const terms = lexicalTokens(document.content)
    lengths.push(terms.length)
    const frequencies = new Map()
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    for (const [term, frequency] of frequencies) {
      const posting = postings[term] ??= { docs: [] }
      posting.docs.push([documentIndex, frequency])
    }
  }
  return {
    schemaVersion: 3,
    tokenizerFingerprint: "unicode-word-cjk-bigram-v1",
    generatedAt,
    truncated,
    documentCount: documents.length,
    averageDocumentLength: lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, lengths.length),
    documents: documents.map((document) => ({ id: document.id, path: document.path, title: document.title, hash: document.hash })),
    lengths,
    postings,
  }
}

export async function warmTaskEmbeddingIndex(workspace, batches) {
  const documents = []
  for (const batch of batches ?? []) {
    for (const chunk of batch.chunks ?? []) {
      documents.push(makeDocument({
        id: `source:${chunk.sourceId}:${chunk.chunkId}`,
        kind: "source-chunk",
        path: `${chunk.sourceId}/${chunk.chunkId}`,
        title: chunkTitle(chunk),
        content: chunk.text,
        sourceId: chunk.sourceId,
        chunkId: chunk.chunkId,
        locator: chunkLocator(chunk),
      }))
    }
  }
  return warmEmbeddingCache(workspace, documents)
}

export async function buildTaskRetrievalIndex(record) {
  const documents = []
  for (const batch of record.batches ?? []) {
    for (const chunk of batch.chunks ?? []) {
      documents.push(makeDocument({
        id: `source:${chunk.sourceId}:${chunk.chunkId}`,
        kind: "source-chunk",
        path: `${chunk.sourceId}/${chunk.chunkId}`,
        title: chunkTitle(chunk),
        content: chunk.text,
        sourceId: chunk.sourceId,
        chunkId: chunk.chunkId,
        locator: chunkLocator(chunk),
      }))
    }
  }
  for (const batchId of record.task.completedBatchIds ?? []) {
    const analysis = await readJson(path.join(record.paths.analysis, `${batchId}.json`), null)
    if (!analysis) continue
    for (const [index, section] of splitSections(analysisContent(analysis), ANALYSIS_SECTION_CHARS).entries()) {
      documents.push(makeDocument({ id: `analysis:${record.task.taskId}:${batchId}:${index}`, kind: "analysis", path: `${record.task.taskId}/${batchId}`, title: analysis.batchSummary || batchId, content: section, section: index }))
    }
  }
  const generatedAt = new Date().toISOString()
  const featureVectors = documents.map((document) => embedText(document.content))
  const featureVectorBytes = encodeFloat32Vectors(featureVectors, VECTOR_DIMENSIONS)
  await writeBufferAtomic(record.paths.featureHashVectors, featureVectorBytes)
  const value = {
    schemaVersion: 1,
    taskId: record.task.taskId,
    generatedAt,
    complete: !["importing", "parsing"].includes(record.task.status),
    documentCount: documents.length,
    bm25: persistedBm25Index(documents, false, generatedAt),
    featureHash: {
      schemaVersion: 3,
      kind: "deterministic-feature-hash-fallback",
      generatedAt,
      truncated: false,
      dimensions: VECTOR_DIMENSIONS,
      documentCount: documents.length,
      documents: documents.map((document) => ({ id: document.id, path: document.path, hash: document.hash })),
      storage: "contiguous-float32-le",
      vectorSha256: sha256(featureVectorBytes),
    },
  }
  await writeJsonAtomic(record.paths.retrievalIndex, value)
  return value
}

function encodeFloat32Vectors(vectors, dimensions) {
  const buffer = Buffer.alloc(vectors.length * dimensions * 4)
  for (let vectorIndex = 0; vectorIndex < vectors.length; vectorIndex += 1) {
    const vector = vectors[vectorIndex]
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      buffer.writeFloatLE(Number(vector?.[dimension]) || 0, (vectorIndex * dimensions + dimension) * 4)
    }
  }
  return buffer
}

function configuredDocumentLimit(workspace) {
  return MAX_RETRIEVAL_DOCUMENTS
}
