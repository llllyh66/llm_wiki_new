import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, rename, rm } from "node:fs/promises"
import path from "node:path"
import { LlmWikiError, fail } from "./errors.js"
import { parseManagedSource, SUPPORTED_SOURCE_TYPES } from "./parser.js"
import {
  cleanDisplayName,
  ensureDir,
  nowIso,
  pathExists,
  readJson,
  relativePosix,
  sha256,
  stripPrivateLocation,
  writeJsonAtomic,
  writeTextAtomic,
} from "./utils.js"

export async function importSources(workspace, files) {
  if (!Array.isArray(files) || files.length === 0) {
    fail("INVALID_INPUT", "files must contain at least one local file path.")
  }
  const accepted = []
  const duplicates = []
  const rejected = []
  for (const input of files) {
    const displayName = cleanDisplayName(input?.display_name ?? input?.displayName, path.basename(String(input?.path ?? "source")))
    try {
      const result = await importOne(workspace, input, displayName)
      if (result.disposition === "duplicate") duplicates.push(result)
      else accepted.push(result)
    } catch (error) {
      const normalized = error instanceof LlmWikiError
        ? error
        : new LlmWikiError("SOURCE_IMPORT_FAILED", error instanceof Error ? error.message : String(error))
      rejected.push({ display_name: displayName, ...normalized.toJSON() })
    }
  }
  return { accepted, duplicates, rejected, all: [...accepted, ...duplicates] }
}

async function importOne(workspace, input, displayName) {
  if (!input || typeof input.path !== "string" || !input.path.trim()) {
    fail("ATTACHMENT_NOT_MATERIALIZED", "The attachment does not have a readable local path.", {
      retryable: true,
      suggestedAction: "Materialize the attachment in the current workspace and retry import_files.",
    })
  }
  const sourcePath = path.resolve(input.path)
  let linkInfo
  try {
    linkInfo = await lstat(sourcePath)
  } catch (error) {
    fail("SOURCE_NOT_FOUND", `Source file not found: ${displayName}`, {
      retryable: true,
      details: { reason: error instanceof Error ? error.code : "not_found" },
    })
  }
  if (linkInfo.isSymbolicLink()) fail("SOURCE_NOT_READABLE", "Symbolic-link attachments are not accepted.")
  if (!linkInfo.isFile()) fail("SOURCE_NOT_READABLE", "The attachment must be a regular file.")
  // display_name is presentation metadata supplied by the caller. It must
  // never select a parser for a materialized file: doing so lets an HTML
  // source be mislabeled as Markdown and bypass htmlToMarkdown sanitization.
  // A materialized path with no extension remains compatible with the legacy
  // attachment contract and falls back to its display label.
  const sourceExtension = path.extname(sourcePath).toLowerCase()
  const displayExtension = path.extname(displayName).toLowerCase()
  const extension = sourceExtension || displayExtension
  const mediaType = SUPPORTED_SOURCE_TYPES[extension]
  if (!mediaType) {
    if (extension === ".xls") fail("UNSUPPORTED_FILE_TYPE", "Legacy .xls workbooks are not supported; save the workbook as .xlsx and retry.")
    fail("UNSUPPORTED_FILE_TYPE", `Unsupported file type: ${extension || "unknown"}`)
  }
  if (linkInfo.size > workspace.config.limits.maxSourceBytes) {
    fail("SOURCE_TOO_LARGE", `Source exceeds the ${workspace.config.limits.maxSourceBytes}-byte workspace limit.`)
  }

  const tempPath = path.join(workspace.paths.importStaging, `import-${randomUUID()}.tmp`)
  let sourceHandle
  let destinationHandle
  const hash = createHash("sha256")
  let sizeBytes = 0
  try {
    sourceHandle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    destinationHandle = await open(tempPath, "wx", 0o600)
    const info = await sourceHandle.stat()
    if (!info.isFile()) fail("SOURCE_NOT_READABLE", "The attachment changed and is no longer a regular file.")
    if (info.size > workspace.config.limits.maxSourceBytes) fail("SOURCE_TOO_LARGE", "Source exceeds the workspace size limit.")
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      sizeBytes += bytesRead
      if (sizeBytes > workspace.config.limits.maxSourceBytes) fail("SOURCE_TOO_LARGE", "Source grew beyond the workspace size limit during import.")
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      await destinationHandle.write(chunk)
    }
    await destinationHandle.sync()
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  } finally {
    await sourceHandle?.close().catch(() => {})
    await destinationHandle?.close().catch(() => {})
  }

  const contentHash = hash.digest("hex")
  const sourceId = `source-${contentHash.slice(0, 24)}`
  const objectDir = path.join(workspace.paths.sourceObjects, contentHash)
  const manifestPath = path.join(workspace.paths.sourceManifests, `${sourceId}.json`)
  const duplicate = await pathExists(manifestPath)
  let manifest = duplicate ? await readJson(manifestPath) : undefined
  if (!duplicate) {
    try {
      await ensureDir(objectDir)
      const managedName = safeManagedName(displayName, extension)
      const managedPath = path.join(objectDir, managedName)
      await rename(tempPath, managedPath)
      const extractedDir = path.join(objectDir, "extracted")
      await ensureDir(extractedDir)
      const parsed = await parseManagedSource(
        managedPath,
        sourceId,
        mediaType,
        { maxChunkChars: workspace.config.limits.maxChunkChars },
      )
      const documentPath = path.join(extractedDir, "document.json")
      const markdownPath = path.join(extractedDir, "document.md")
      const chunksPath = path.join(extractedDir, "chunks.json")
      await writeJsonAtomic(documentPath, parsed.document)
      await writeTextAtomic(markdownPath, parsed.markdown)
      await writeJsonAtomic(chunksPath, parsed.chunks)
      manifest = {
        schemaVersion: 1,
        sourceId,
        contentHash,
        originalName: displayName,
        managedRelativePath: relativePosix(workspace.paths.root, managedPath),
        mediaType,
        sizeBytes,
        importedAt: nowIso(),
        originalLocationHint: stripPrivateLocation(sourcePath),
        parserVersion: "headless-document-v3",
        extractedDocumentPath: relativePosix(workspace.paths.root, documentPath),
        chunksPath: relativePosix(workspace.paths.root, chunksPath),
        extractionHash: sha256(parsed.markdown),
        status: "parsed",
        metadata: { chunkCount: parsed.chunks.length },
      }
      await writeJsonAtomic(path.join(objectDir, "metadata.json"), manifest)
      await writeJsonAtomic(manifestPath, manifest)
    } catch (error) {
      await rm(objectDir, { recursive: true, force: true }).catch(() => {})
      await rm(tempPath, { force: true }).catch(() => {})
      throw error
    }
  } else {
    await rm(tempPath, { force: true })
  }
  const chunks = await readJson(path.join(workspace.paths.root, manifest.chunksPath))
  return {
    source_id: sourceId,
    display_name: displayName,
    content_hash: contentHash,
    managed_path: manifest.managedRelativePath,
    chunk_count: chunks.length,
    disposition: duplicate ? "duplicate" : "imported",
    ...(duplicate ? { duplicate_of: sourceId } : {}),
    manifest,
    chunks,
  }
}

function safeManagedName(displayName, extension) {
  const base = path.basename(displayName).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 180)
  if (base && path.extname(base)) return base
  return `original${extension}`
}

export async function loadSourceManifest(paths, sourceId) {
  return readJson(path.join(paths.sourceManifests, `${sourceId}.json`))
}

export async function loadSourceChunks(paths, sourceId) {
  const manifest = await loadSourceManifest(paths, sourceId)
  return readJson(path.join(paths.root, manifest.chunksPath))
}
