import { readFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { listFilesRecursive, readJson, relativePosix, sha256, tokenize } from "./utils.js"

const RRF_K = 60
const VECTOR_DIMENSIONS = 256

export async function retrieveContext(workspace, taskRecord, queries, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100)
  const requested = new Set(Array.isArray(options.channels) && options.channels.length > 0 ? options.channels : ["bm25", "vector", "graph"])
  const queryTerms = [...new Set(queries.flatMap((query) => tokenize(query)))]
  const documents = await retrievalDocuments(workspace, taskRecord)
  const rankings = {}
  if (requested.has("bm25")) rankings.bm25 = scoreBm25(documents, queryTerms)
  if (requested.has("vector")) rankings.vector = scoreVectors(documents, queries.join("\n"))
  if (requested.has("graph")) rankings.graph = scoreGraph(documents, rankings.bm25 ?? rankings.vector ?? [])
  const fused = fuseRankings(documents, rankings)
  const maxChars = Math.min(Number(options.maxChars) || 60_000, 120_000)
  const hits = []
  let usedChars = 0
  let truncated = false
  for (const item of fused.slice(0, limit)) {
    const snippet = buildSnippet(item.document.content, queryTerms, 900)
    if (usedChars + snippet.length > maxChars) {
      truncated = true
      break
    }
    usedChars += snippet.length
    hits.push({
      kind: item.document.kind,
      path: item.document.path,
      title: item.document.title,
      snippet,
      score: item.score,
      scores: item.scores,
      file_hash: item.document.hash,
    })
  }
  const available = Object.keys(rankings)
  return {
    hits,
    fusion: "rrf",
    wiki_revision: workspace.revision,
    truncated,
    available_channels: available,
    pending_channels: [...requested].filter((channel) => !available.includes(channel)),
  }
}

async function retrievalDocuments(workspace, taskRecord) {
  const documents = []
  for (const file of await listFilesRecursive(workspace.paths.wiki, (candidate) => candidate.endsWith(".md"))) {
    const content = await readFile(file, "utf8")
    documents.push({ kind: "wiki-page", path: `wiki/${relativePosix(workspace.paths.wiki, file)}`, title: extractTitle(content, path.basename(file, ".md")), content, hash: sha256(content) })
  }
  for (const batchId of taskRecord.task.completedBatchIds) {
    const analysisPath = path.join(taskRecord.paths.analysis, `${batchId}.json`)
    const analysis = await readJson(analysisPath)
    const content = [analysis.batchSummary, ...analysis.unresolvedQuestions, ...analysis.claims.map((item) => item.text ?? item.claim ?? JSON.stringify(item))].join("\n")
    documents.push({ kind: "analysis", path: `${taskRecord.task.taskId}/${batchId}`, title: batchId, content, hash: sha256(content) })
  }
  return documents
}

function scoreBm25(documents, queryTerms) {
  if (queryTerms.length === 0) return []
  const documentTerms = documents.map((document) => tokenize(document.content))
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
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || documents[a.documentIndex].path.localeCompare(documents[b.documentIndex].path))
}

function scoreVectors(documents, query) {
  const queryVector = embedText(query)
  return documents.map((document, documentIndex) => ({ documentIndex, score: cosine(queryVector, embedText(`${document.title}\n${document.content}`)) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || documents[a.documentIndex].path.localeCompare(documents[b.documentIndex].path))
}

function scoreGraph(documents, seeds) {
  const wikiIndexes = new Map()
  documents.forEach((document, index) => {
    if (document.kind !== "wiki-page") return
    const slug = normalizeWikiTarget(document.path)
    wikiIndexes.set(slug, index)
    wikiIndexes.set(path.posix.basename(slug), index)
  })
  const neighbors = new Map()
  documents.forEach((document, index) => {
    if (document.kind !== "wiki-page") return
    for (const match of document.content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const target = wikiIndexes.get(normalizeWikiTarget(match[1])) ?? wikiIndexes.get(path.posix.basename(normalizeWikiTarget(match[1])))
      if (target === undefined) continue
      addNeighbor(neighbors, index, target)
      addNeighbor(neighbors, target, index)
    }
  })
  const scores = new Map()
  seeds.slice(0, 10).forEach((seed, rank) => {
    for (const neighbor of neighbors.get(seed.documentIndex) ?? []) scores.set(neighbor, (scores.get(neighbor) ?? 0) + 1 / (rank + 1))
  })
  return [...scores].map(([documentIndex, score]) => ({ documentIndex, score })).sort((a, b) => b.score - a.score)
}

function addNeighbor(graph, source, target) {
  const values = graph.get(source) ?? new Set()
  values.add(target)
  graph.set(source, values)
}

function fuseRankings(documents, rankings) {
  const fused = new Map()
  for (const [channel, ranking] of Object.entries(rankings)) {
    ranking.forEach((item, rank) => {
      const current = fused.get(item.documentIndex) ?? { document: documents[item.documentIndex], score: 0, scores: {} }
      current.score += 1 / (RRF_K + rank + 1)
      current.scores[channel] = item.score
      current.scores.rrf = current.score
      fused.set(item.documentIndex, current)
    })
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.document.path.localeCompare(b.document.path))
}

export function embedText(text) {
  const vector = new Array(VECTOR_DIMENSIONS).fill(0)
  const normalized = text.normalize("NFKC").toLowerCase()
  const features = [...tokenize(normalized)]
  const characters = Array.from(normalized.replace(/\s+/g, " "))
  for (let index = 0; index < characters.length - 2; index += 1) features.push(characters.slice(index, index + 3).join(""))
  for (const feature of features) {
    const digest = createHash("sha256").update(feature).digest()
    const bucket = digest.readUInt16BE(0) % VECTOR_DIMENSIONS
    vector[bucket] += (digest[2] & 1) === 0 ? 1 : -1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm > 0 ? vector.map((value) => value / norm) : vector
}

function cosine(left, right) {
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

function extractTitle(content, fallback) {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback
}

function normalizeWikiTarget(value) {
  return value.replace(/\\/g, "/").replace(/^wiki\//i, "").replace(/\.md$/i, "").normalize("NFKC").toLowerCase()
}

export async function buildBm25Index(workspace) {
  const pages = []
  for (const file of await listFilesRecursive(workspace.paths.wiki, (candidate) => candidate.endsWith(".md"))) {
    const content = await readFile(file, "utf8")
    pages.push({ path: `wiki/${relativePosix(workspace.paths.wiki, file)}`, title: extractTitle(content, path.basename(file, ".md")), hash: sha256(content), terms: tokenize(content) })
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), pages }
}

export async function buildVectorIndex(workspace) {
  const pages = []
  for (const file of await listFilesRecursive(workspace.paths.wiki, (candidate) => candidate.endsWith(".md"))) {
    const content = await readFile(file, "utf8")
    pages.push({ path: `wiki/${relativePosix(workspace.paths.wiki, file)}`, hash: sha256(content), dimensions: VECTOR_DIMENSIONS, vector: embedText(content) })
  }
  return { schemaVersion: 1, kind: "deterministic-feature-hash", generatedAt: new Date().toISOString(), pages }
}
