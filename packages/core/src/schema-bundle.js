import { lstat, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"
import { ensureDir, sha256, stableStringify, writeTextAtomic } from "./utils.js"

export const PROGRESSIVE_SCHEMA_MODE = "progressive-directory-v2"
export const PROGRESSIVE_SCHEMA_VERSION = "2"
export const PROGRESSIVE_SCHEMA_ROOT_FILE = "all_domains.json"
export const MAX_SCHEMA_BUNDLE_BYTES = 20 * 1024 * 1024
export const MAX_SCHEMA_BUNDLE_FILES = 2_000
// ABE files are disclosed verbatim. Keep a generous per-file safety ceiling
// for accidental or binary blobs while bounding the complete directory.
export const MAX_SCHEMA_FILE_BYTES = 5 * 1024 * 1024

export function isProgressiveSchema(schema) {
  return schema?.mode === PROGRESSIVE_SCHEMA_MODE
}

export async function resolveProgressiveSchemaDirectory(rootPath) {
  const rootInfo = await safeLstat(rootPath)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    fail("INVALID_DOMAIN_SCHEMA", "The progressive domain Schema must be a regular directory, not a symbolic link.")
  }
  const files = []
  const domainFolders = new Set()
  let totalBytes = 0
  async function walk(current, relativeDir = "") {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      const absolutePath = path.join(current, entry.name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) fail("INVALID_DOMAIN_SCHEMA", `Schema path may not contain symbolic links: ${relativePath}`)
      if (entry.isDirectory()) {
        if (relativeDir.includes("/")) fail("INVALID_DOMAIN_SCHEMA", `Schema directories may only be one level deep: ${relativePath}`)
        domainFolders.add(relativePath)
        await walk(absolutePath, relativePath)
        continue
      }
      if (!entry.isFile()) continue
      if (!relativePath.toLowerCase().endsWith(".json")) continue
      if (info.size > MAX_SCHEMA_FILE_BYTES) fail("INVALID_DOMAIN_SCHEMA", `Schema JSON exceeds ${MAX_SCHEMA_FILE_BYTES} bytes: ${relativePath}`)
      const raw = await readFile(absolutePath, "utf8").catch(() => {
        fail("INVALID_DOMAIN_SCHEMA", `Schema JSON is not readable UTF-8: ${relativePath}`)
      })
      let content
      try {
        content = JSON.parse(raw)
      } catch {
        fail("INVALID_DOMAIN_SCHEMA", `Schema JSON is invalid: ${relativePath}`)
      }
      const bytes = Buffer.byteLength(raw)
      totalBytes += bytes
      files.push({ relativePath, raw, content, bytes, hash: sha256(raw) })
      if (files.length > MAX_SCHEMA_BUNDLE_FILES) fail("INVALID_DOMAIN_SCHEMA", `Schema folder contains more than ${MAX_SCHEMA_BUNDLE_FILES} JSON files.`)
      if (totalBytes > MAX_SCHEMA_BUNDLE_BYTES) fail("INVALID_DOMAIN_SCHEMA", `Schema folder exceeds ${MAX_SCHEMA_BUNDLE_BYTES} bytes.`)
    }
  }
  await walk(rootPath)
  const root = files.find((file) => file.relativePath === PROGRESSIVE_SCHEMA_ROOT_FILE)
  if (!root) fail("INVALID_DOMAIN_SCHEMA", `Schema folder must contain ${PROGRESSIVE_SCHEMA_ROOT_FILE}.`)
  for (const folder of domainFolders) {
    const expected = `${folder}/${folder}_domain.json`
    if (!files.some((file) => file.relativePath === expected)) {
      fail("INVALID_DOMAIN_SCHEMA", `Domain folder ${folder} must contain ${folder}_domain.json.`)
    }
  }
  const manifestFiles = files
    .map(({ relativePath, bytes, hash }) => ({ relative_path: relativePath, bytes, hash }))
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path))
  const snapshotHash = sha256(stableStringify({ mode: PROGRESSIVE_SCHEMA_MODE, files: manifestFiles }))
  const manifest = {
    mode: PROGRESSIVE_SCHEMA_MODE,
    version: PROGRESSIVE_SCHEMA_VERSION,
    root_file: PROGRESSIVE_SCHEMA_ROOT_FILE,
    snapshot_hash: snapshotHash,
    total_bytes: totalBytes,
    file_count: files.length,
    files: manifestFiles,
  }
  return makeProgressiveSchema(manifest, files)
}

export async function loadProgressiveSchemaSnapshot(record) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(record.paths.domainSchema, "utf8"))
  } catch {
    fail("INVALID_DOMAIN_SCHEMA", "Task Schema snapshot manifest is not valid JSON.")
  }
  if (manifest?.mode !== PROGRESSIVE_SCHEMA_MODE) fail("INVALID_DOMAIN_SCHEMA", "Task Schema snapshot manifest has an unsupported mode.")
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_SCHEMA_BUNDLE_FILES) {
    fail("INVALID_DOMAIN_SCHEMA", "Task Schema snapshot manifest has an invalid file list.")
  }
  if (manifest.root_file !== PROGRESSIVE_SCHEMA_ROOT_FILE || manifest.version !== PROGRESSIVE_SCHEMA_VERSION) {
    fail("INVALID_DOMAIN_SCHEMA", "Task Schema snapshot manifest has an unsupported version or root file.")
  }
  const expectedManifestFiles = manifest.files
    .map((item) => ({ relative_path: safeRelativePath(item?.relative_path), bytes: Number(item?.bytes), hash: String(item?.hash ?? "") }))
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path))
  if (expectedManifestFiles.some((item) => !Number.isInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_SCHEMA_FILE_BYTES || !/^[0-9a-f]{64}$/i.test(item.hash))) {
    fail("INVALID_DOMAIN_SCHEMA", "Task Schema snapshot manifest contains invalid file metadata.")
  }
  if (!expectedManifestFiles.some((item) => item.relative_path === PROGRESSIVE_SCHEMA_ROOT_FILE)) {
    fail("INVALID_DOMAIN_SCHEMA", `Task Schema snapshot manifest must contain ${PROGRESSIVE_SCHEMA_ROOT_FILE}.`)
  }
  if (new Set(expectedManifestFiles.map((item) => item.relative_path)).size !== expectedManifestFiles.length) {
    fail("INVALID_DOMAIN_SCHEMA", "Task Schema snapshot manifest contains duplicate file paths.")
  }
  const expectedSnapshotHash = sha256(stableStringify({ mode: PROGRESSIVE_SCHEMA_MODE, files: expectedManifestFiles }))
  if (manifest.snapshot_hash !== expectedSnapshotHash || manifest.file_count !== expectedManifestFiles.length) {
    fail("INVALID_DOMAIN_SCHEMA", "Task Schema snapshot manifest hash or file count is invalid.")
  }
  const files = []
  for (const item of expectedManifestFiles) {
    const relativePath = item.relative_path
    const target = path.join(record.paths.domainSchemaRoot, "files", relativePath)
    const raw = await readFile(target, "utf8").catch(() => {
      fail("INVALID_DOMAIN_SCHEMA", `Task Schema snapshot is missing: ${relativePath}`)
    })
    if (sha256(raw) !== item.hash) fail("INVALID_DOMAIN_SCHEMA", `Task Schema snapshot hash mismatch: ${relativePath}`)
    if (Buffer.byteLength(raw) !== item.bytes) fail("INVALID_DOMAIN_SCHEMA", `Task Schema snapshot byte count mismatch: ${relativePath}`)
    let content
    try {
      content = JSON.parse(raw)
    } catch {
      fail("INVALID_DOMAIN_SCHEMA", `Task Schema snapshot is invalid JSON: ${relativePath}`)
    }
    files.push({ relativePath, raw, content, bytes: Buffer.byteLength(raw), hash: item.hash })
  }
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  if (totalBytes !== manifest.total_bytes || totalBytes > MAX_SCHEMA_BUNDLE_BYTES) {
    fail("INVALID_DOMAIN_SCHEMA", "Task Schema snapshot total byte count is invalid.")
  }
  const domainFolders = new Set(files.map((file) => file.relativePath.split("/")[0]).filter((value) => value !== PROGRESSIVE_SCHEMA_ROOT_FILE && value.includes("/")))
  for (const folder of domainFolders) {
    if (!files.some((file) => file.relativePath === `${folder}/${folder}_domain.json`)) {
      fail("INVALID_DOMAIN_SCHEMA", `Task Schema snapshot domain folder ${folder} is missing ${folder}_domain.json.`)
    }
  }
  return makeProgressiveSchema(manifest, files)
}

export async function writeProgressiveSchemaSnapshot(paths, bundle) {
  await ensureDir(path.join(paths.domainSchemaRoot, "files"))
  await Promise.all(bundle.files.map((file) => writeTextAtomic(path.join(paths.domainSchemaRoot, "files", file.relativePath), file.raw)))
  return bundle.manifest
}

export function progressiveSchemaMetadata(bundle) {
  return {
    schema_mode: PROGRESSIVE_SCHEMA_MODE,
    schema_id: bundle.manifest.snapshot_hash,
    schema_version: PROGRESSIVE_SCHEMA_VERSION,
    hash: bundle.manifest.snapshot_hash,
    size_bytes: bundle.manifest.total_bytes,
    file_count: bundle.manifest.file_count,
    root_file: bundle.manifest.root_file,
  }
}

export function progressiveSchemaFile(bundle, relativePath) {
  const normalized = safeRelativePath(relativePath)
  return bundle.files.find((file) => file.relativePath === normalized) ?? null
}

export function progressiveSchemaDisclosure(bundle, input = {}) {
  const level = String(input.level ?? "domains").trim().toLowerCase()
  if (!["domains", "domain", "abe"].includes(level)) fail("INVALID_INPUT", "level must be domains, domain, or abe.")
  let relativePath = PROGRESSIVE_SCHEMA_ROOT_FILE
  if (level === "domain") {
    const folder = safePathPart(input.domain_folder, "domain_folder")
    relativePath = `${folder}/${folder}_domain.json`
  }
  if (level === "abe") {
    const folder = safePathPart(input.domain_folder, "domain_folder")
    const file = safePathPart(input.abe_file, "abe_file")
    if (!file.toLowerCase().endsWith(".json") || file.toLowerCase().endsWith("_domain.json")) fail("INVALID_INPUT", "abe_file must name a non-domain JSON file.")
    relativePath = `${folder}/${file}`
  }
  const disclosed = progressiveSchemaFile(bundle, relativePath)
  if (!disclosed) fail("SCHEMA_FILE_NOT_FOUND", `Schema file does not exist in the task snapshot: ${relativePath}`)
  const navigation = {}
  if (level === "domains") {
    navigation.available_domain_folders = [...new Set(bundle.files
      .map((file) => file.relativePath.split("/")[0])
      .filter((folder) => folder !== PROGRESSIVE_SCHEMA_ROOT_FILE && bundle.files.some((file) => file.relativePath === `${folder}/${folder}_domain.json`)))].sort()
  } else if (level === "domain") {
    const folder = relativePath.split("/")[0]
    navigation.available_abe_files = bundle.files
      .filter((file) => file.relativePath.startsWith(`${folder}/`) && file.relativePath !== `${folder}/${folder}_domain.json`)
      .map((file) => file.relativePath.slice(folder.length + 1))
      .sort()
  }
  return {
    level,
    relative_path: disclosed.relativePath,
    file_hash: disclosed.hash,
    bytes: disclosed.bytes,
    content: disclosed.content,
    navigation,
    snapshot_hash: bundle.manifest.snapshot_hash,
    full_file_exposed: true,
    next_action: level === "domains"
      ? { tool: "llm_wiki_get_domain_schema", arguments: { task_id: input.task_id, level: "domain", domain_folder: "<selected-domain-folder>" } }
      : level === "domain"
        ? { tool: "llm_wiki_get_domain_schema", arguments: { task_id: input.task_id, level: "abe", domain_folder: input.domain_folder, abe_file: "<selected-abe-file>" } }
        : null,
  }
}

export function applyProgressiveSchema(analysis, bundle) {
  if (!bundle) return { analysis, report: null }
  const errors = []
  const checkCandidate = (candidate, collection, index) => {
    const classification = candidate?.schemaClassification ?? candidate?.schema_classification
    if (!classification || typeof classification !== "object") {
      errors.push(`${collection}[${index}].schemaClassification is required when a progressive Schema is active`)
      return candidate
    }
    const suppliedSnapshotHash = String(classification.snapshotHash ?? classification.snapshot_hash ?? "").trim()
    if (suppliedSnapshotHash && suppliedSnapshotHash.toLowerCase() !== bundle.manifest.snapshot_hash.toLowerCase()) {
      errors.push(`${collection}[${index}].schemaClassification.snapshotHash does not match the task Schema snapshot`)
    }
    const status = String(classification.status ?? "classified").trim().toLowerCase()
    if (!["classified", "unresolved"].includes(status)) errors.push(`${collection}[${index}].schemaClassification.status must be classified or unresolved`)
    if (status === "unresolved") return { ...candidate, schemaClassification: { ...classification, status, snapshotHash: bundle.manifest.snapshot_hash } }
    const domain = classification.domain
    const abe = classification.abe
    const be = classification.be
    if (!domain || !abe || !be) {
      errors.push(`${collection}[${index}].schemaClassification must include domain, abe, and be`)
      return candidate
    }
    const domainFolder = String(domain.key ?? domain.folder ?? "").trim()
    const abeFile = String(abe.file ?? abe.key ?? "").trim()
    const bePointer = String(be.pointer ?? be.jsonPointer ?? "").trim()
    const validDomainFolder = Boolean(domainFolder) && ![".", ".."].includes(domainFolder)
      && !domainFolder.includes("/") && !domainFolder.includes("\\") && !domainFolder.includes("\0")
    const domainFile = validDomainFolder ? progressiveSchemaFile(bundle, `${domainFolder}/${domainFolder}_domain.json`) : null
    let abeRelative = ""
    if (abeFile.includes("/")) {
      try { abeRelative = safeRelativePath(abeFile) } catch { errors.push(`${collection}[${index}].schemaClassification.abe.file is not a safe relative path`) }
    } else if (abeFile) {
      abeRelative = `${domainFolder}/${abeFile.endsWith(".json") ? abeFile : `${abeFile}.json`}`
    }
    const abeSchemaFile = abeRelative && validDomainFolder ? progressiveSchemaFile(bundle, abeRelative) : null
    const abeDataFile = abeSchemaFile && !abeSchemaFile.relativePath.endsWith("_domain.json") ? abeSchemaFile : null
    if (!validDomainFolder || !domainFile) errors.push(`${collection}[${index}].schemaClassification.domain.key is not a known domain folder`)
    if (!abeDataFile) errors.push(`${collection}[${index}].schemaClassification.abe.file is not a known ABE JSON file`)
    if (!bePointer || !abeDataFile || resolveJsonPointer(abeDataFile.content, bePointer) === undefined) errors.push(`${collection}[${index}].schemaClassification.be.pointer does not resolve in the selected ABE JSON`)
    const abeKey = path.posix.basename(abeFile).replace(/\.json$/i, "")
    const normalized = {
      ...candidate,
      schemaClassification: {
        ...classification,
        status: "classified",
        domain: { ...domain, key: domainFolder, file: domainFile?.relativePath ?? `${domainFolder}/${domainFolder}_domain.json` },
        abe: { ...abe, key: abeKey, file: abeDataFile?.relativePath ?? abeFile },
        be: { ...be, pointer: bePointer, key: String(be.key ?? `${abeKey}#${bePointer}`).trim() },
        snapshotHash: bundle.manifest.snapshot_hash,
      },
    }
    return normalized
  }
  const entities = (analysis.entities ?? []).map((candidate, index) => checkCandidate(candidate, "entities", index))
  const concepts = (analysis.concepts ?? []).map((candidate, index) => checkCandidate(candidate, "concepts", index))
  if (errors.length > 0) fail("INVALID_DOMAIN_ANALYSIS", "Analysis does not conform to the progressive Schema classification contract.", { details: { validation_errors: errors.slice(0, 100), validation_error_count: errors.length, schema_mode: PROGRESSIVE_SCHEMA_MODE } })
  return {
    analysis: { ...analysis, entities, concepts },
    report: { schema_mode: PROGRESSIVE_SCHEMA_MODE, snapshot_hash: bundle.manifest.snapshot_hash, validation_error_count: 0, classified_entities: entities.filter((item) => item.schemaClassification?.status === "classified").length, classified_concepts: concepts.filter((item) => item.schemaClassification?.status === "classified").length },
  }
}

function makeProgressiveSchema(manifest, files) {
  return {
    mode: PROGRESSIVE_SCHEMA_MODE,
    formatVersion: PROGRESSIVE_SCHEMA_VERSION,
    schemaId: manifest.snapshot_hash,
    schemaVersion: PROGRESSIVE_SCHEMA_VERSION,
    name: "Progressive directory Schema",
    description: "Unrestricted JSON files disclosed Domain -> ABE -> BE.",
    language: "und",
    manifest,
    files,
  }
}

function resolveJsonPointer(value, pointer) {
  if (pointer === "") return value
  if (!pointer.startsWith("/")) return undefined
  let current = value
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~")
    if (current === null || current === undefined || !Object.hasOwn(Object(current), part)) return undefined
    current = current[part]
  }
  return current
}

function safePathPart(value, field) {
  const normalized = String(value ?? "").normalize("NFKC").trim()
  if (!normalized || normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) fail("INVALID_INPUT", `${field} must be one relative path segment.`)
  return normalized
}

function safeRelativePath(value) {
  const normalized = String(value ?? "").replace(/\\/g, "/")
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) fail("INVALID_DOMAIN_SCHEMA", `Invalid Schema relative path: ${normalized}`)
  return normalized
}

async function safeLstat(target) {
  try {
    return await lstat(target)
  } catch {
    return null
  }
}
