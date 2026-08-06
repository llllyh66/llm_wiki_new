import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, rename, rm } from "node:fs/promises"
import path from "node:path"
import { LlmWikiError, fail } from "./errors.js"
import { parseManagedSource, SUPPORTED_SOURCE_TYPES } from "./parser.js"
import { EXCEL_MEDIA_TYPE, resolveSpreadsheetProvider, spreadsheetParserFingerprint, spreadsheetParserVersion } from "./spreadsheet-parser.js"
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
  const extension = path.extname(displayName).toLowerCase() || path.extname(sourcePath).toLowerCase()
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
  const spreadsheetOptions = workspace.config.parsing?.excel ?? {}
  const selectedSpreadsheetProvider = mediaType === EXCEL_MEDIA_TYPE
    ? await resolveSpreadsheetProvider(spreadsheetOptions).catch((error) => {
      if (spreadsheetOptions.provider === "excel-parser") throw error
      return "native"
    })
    : null
  const expectedParserFingerprint = mediaType === EXCEL_MEDIA_TYPE
    ? spreadsheetParserFingerprint({ ...spreadsheetOptions, maxChunkChars: workspace.config.limits.maxChunkChars }, selectedSpreadsheetProvider)
    : "headless-document-v3"
  const existingProvider = manifest?.metadata?.parser?.provider
  const explicitProviderChange = mediaType === EXCEL_MEDIA_TYPE
    && spreadsheetOptions.provider !== "auto"
    && existingProvider !== (selectedSpreadsheetProvider === "enhanced" ? "excel-parser" : "native")
  const missingFingerprint = duplicate && !manifest?.parserFingerprint
  const needsReparse = duplicate && (
    missingFingerprint
    || explicitProviderChange
    || (spreadsheetOptions.provider !== "auto" && manifest?.parserFingerprint !== expectedParserFingerprint)
  )
  if (!duplicate || needsReparse) {
    let managedPath
    let extractedWriteDir
    try {
      await ensureDir(objectDir)
      if (!duplicate) {
        const managedName = safeManagedName(displayName, extension)
        managedPath = path.join(objectDir, managedName)
        await rename(tempPath, managedPath)
      } else {
        managedPath = path.join(workspace.paths.root, manifest.managedRelativePath)
        await rm(tempPath, { force: true })
      }
      const extractedDir = path.join(objectDir, "extracted")
      extractedWriteDir = duplicate ? path.join(objectDir, `extracted-next-${randomUUID()}`) : extractedDir
      await ensureDir(extractedWriteDir)
      const parsed = await parseManagedSource(
        managedPath,
        sourceId,
        mediaType,
        { maxChunkChars: workspace.config.limits.maxChunkChars, spreadsheet: spreadsheetOptions },
      )
      const documentPath = path.join(extractedWriteDir, "document.json")
      const markdownPath = path.join(extractedWriteDir, "document.md")
      const chunksPath = path.join(extractedWriteDir, "chunks.json")
      await writeJsonAtomic(documentPath, parsed.document)
      await writeTextAtomic(markdownPath, parsed.markdown)
      await writeJsonAtomic(chunksPath, parsed.chunks)
      if (duplicate) {
        await rm(extractedDir, { recursive: true, force: true })
        await rename(extractedWriteDir, extractedDir)
      }
      const actualParserFingerprint = mediaType === EXCEL_MEDIA_TYPE
        ? spreadsheetParserFingerprint(
          { ...spreadsheetOptions, maxChunkChars: workspace.config.limits.maxChunkChars },
          parsed.parser?.provider === "excel-parser" ? "enhanced" : "native",
        )
        : expectedParserFingerprint
      manifest = {
        ...(duplicate ? manifest : {}),
        schemaVersion: 2,
        sourceId,
        contentHash,
        originalName: displayName,
        managedRelativePath: relativePosix(workspace.paths.root, managedPath),
        mediaType,
        sizeBytes,
        importedAt: manifest?.importedAt ?? nowIso(),
        ...(duplicate ? { reparsedAt: nowIso() } : {}),
        originalLocationHint: stripPrivateLocation(sourcePath),
        parserVersion: parsed.parser ? spreadsheetParserVersion(parsed) : "headless-document-v3",
        parserFingerprint: actualParserFingerprint,
        extractedDocumentPath: relativePosix(workspace.paths.root, documentPath),
        chunksPath: relativePosix(workspace.paths.root, chunksPath),
        extractionHash: sha256(`${actualParserFingerprint}:${parsed.markdown}`),
        status: "parsed",
        metadata: { ...(manifest?.metadata ?? {}), ...(parsed.document.metadata ?? {}), chunkCount: parsed.chunks.length },
      }
      await writeJsonAtomic(path.join(objectDir, "metadata.json"), manifest)
      await writeJsonAtomic(manifestPath, manifest)
    } catch (error) {
      if (!duplicate) await rm(objectDir, { recursive: true, force: true }).catch(() => {})
      else if (extractedWriteDir) await rm(extractedWriteDir, { recursive: true, force: true }).catch(() => {})
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
    ...(needsReparse ? { reparsed: true } : {}),
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
