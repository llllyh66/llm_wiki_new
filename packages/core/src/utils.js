import { createHash, randomUUID } from "node:crypto"
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

export const nowIso = () => new Date().toISOString()
export const newId = (prefix) => `${prefix}-${randomUUID()}`
export const sha256 = (value) => createHash("sha256").update(value).digest("hex")

// String offsets in the parser and batching contracts are UTF-16 offsets.
// Keep a chosen boundary from landing between the two code units of one
// supplementary Unicode character (emoji, historic scripts, etc.).
export function safeTextCut(text, cut, minimum = 0) {
  const value = String(text ?? "")
  const bounded = Math.min(Math.max(Math.trunc(Number(cut) || 0), 0), value.length)
  if (bounded > 0
    && bounded < value.length
    && value.charCodeAt(bounded - 1) >= 0xD800
    && value.charCodeAt(bounded - 1) <= 0xDBFF
    && value.charCodeAt(bounded) >= 0xDC00
    && value.charCodeAt(bounded) <= 0xDFFF) {
    const backward = bounded - 1
    return backward > minimum ? backward : Math.min(value.length, bounded + 1)
  }
  return bounded
}

export async function sha256File(filePath) {
  const handle = await open(filePath, "r")
  const hash = createHash("sha256")
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk)
    return hash.digest("hex")
  } finally {
    await handle.close().catch(() => {})
  }
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true })
}

export async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (error && error.code === "ENOENT") return false
    throw error
  }
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"))
  } catch (error) {
    if (fallback !== undefined && error && error.code === "ENOENT") return fallback
    throw error
  }
}

export async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath))
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  const payload = `${JSON.stringify(value, null, 2)}\n`
  try {
    const handle = await open(temp, "wx", 0o600)
    try {
      await handle.writeFile(payload, "utf8")
      await handle.sync()
    } finally {
      await handle.close().catch(() => {})
    }
    await rename(temp, filePath)
    await syncDirectory(path.dirname(filePath))
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function writeTextAtomic(filePath, content) {
  await ensureDir(path.dirname(filePath))
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    const handle = await open(temp, "wx", 0o600)
    try {
      await handle.writeFile(content, "utf8")
      await handle.sync()
    } finally {
      await handle.close().catch(() => {})
    }
    await rename(temp, filePath)
    await syncDirectory(path.dirname(filePath))
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function syncDirectory(directory) {
  let handle
  try {
    handle = await open(directory, "r")
    await handle.sync()
  } catch (error) {
    // Directory fsync is supported on POSIX filesystems but can be rejected
    // on Windows. File contents are still fsynced; tolerate only the known
    // platform limitations and surface all other durability failures.
    if (!new Set(["EINVAL", "EPERM", "ENOTSUP"]).has(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function listFilesRecursive(root, predicate = () => true) {
  if (!(await pathExists(root))) return []
  const result = []
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile() && predicate(absolute)) result.push(absolute)
    }
  }
  await walk(root)
  return result
}

export async function mapWithConcurrency(values, concurrency, mapper) {
  const items = Array.from(values)
  if (items.length === 0) return []
  const results = new Array(items.length)
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(Number(concurrency) || 1)))
  let cursor = 0
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(items[index], index)
    }
  }))
  return results
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export async function removeIfExists(target) {
  await rm(target, { recursive: true, force: true })
}

export function relativePosix(root, target) {
  return path.relative(root, target).split(path.sep).join("/")
}

export function stripPrivateLocation(filePath) {
  return path.basename(filePath)
}

export function cleanDisplayName(value, fallback) {
  const candidate = typeof value === "string" ? path.basename(value.trim()) : ""
  return candidate && candidate !== "." && candidate !== path.sep ? candidate : fallback
}

const STOP_WORDS = new Set([
  "the", "is", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "this", "that", "these", "those", "be", "as", "by", "from", "it", "its",
  "的", "是", "了", "在", "有", "和", "与", "对", "从", "一个",
])

export function tokenize(text) {
  const normalized = text.normalize("NFKC").toLowerCase()
  const tokens = []
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0]
    if (!STOP_WORDS.has(token) && token.length > 1) tokens.push(token)
    if (/[\u3400-\u9fff]/u.test(token)) {
      const chars = Array.from(token)
      for (let index = 0; index < chars.length - 1; index += 1) {
        const bigram = `${chars[index]}${chars[index + 1]}`
        if (!STOP_WORDS.has(bigram)) tokens.push(bigram)
      }
    }
  }
  return [...new Set(tokens)]
}

export async function hashDirectory(root, predicate = (file) => file.endsWith(".md")) {
  const files = await listFilesRecursive(root, predicate)
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(relativePosix(root, file))
    hash.update("\0")
    hash.update(await readFile(file))
    hash.update("\0")
  }
  return hash.digest("hex")
}

export async function writeFileExclusive(filePath, content) {
  await ensureDir(path.dirname(filePath))
  await writeFile(filePath, content, { flag: "wx", mode: 0o600 })
}

export async function acquireProcessFileLock(filePath, metadata = {}, options = {}) {
  const waitMs = Math.max(0, Number(options.waitMs) || 0)
  const retryMs = Math.min(Math.max(Number(options.retryMs) || 25, 10), 1_000)
  const unreadableStaleMs = Math.max(Number(options.unreadableStaleMs) || 120_000, 10_000)
  const startedAt = Date.now()
  await ensureDir(path.dirname(filePath))
  while (true) {
    const lockId = newId("lock")
    let handle
    try {
      handle = await open(filePath, "wx", 0o600)
      await handle.writeFile(`${JSON.stringify({ ...metadata, lockId, pid: process.pid, createdAt: nowIso() })}\n`, "utf8")
      await handle.sync()
      return async () => {
        await handle.close().catch(() => {})
        const current = await readFile(filePath, "utf8").catch(() => "")
        if (current.includes(`\"lockId\":\"${lockId}\"`)) await rm(filePath, { force: true }).catch(() => {})
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error?.code !== "EEXIST") throw error
      if (await removeStaleProcessLock(filePath, unreadableStaleMs)) continue
      if (Date.now() - startedAt >= waitMs) {
        const busy = new Error("The file lock is held by another live process.")
        busy.code = "FILE_LOCK_BUSY"
        throw busy
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
  }
}

async function removeStaleProcessLock(filePath, unreadableStaleMs) {
  const before = await readFile(filePath, "utf8").catch(() => null)
  if (before === null) return true
  let record
  try { record = JSON.parse(before) } catch { record = null }
  if (Number.isInteger(record?.pid) && processIsAlive(record.pid)) return false
  if (!Number.isInteger(record?.pid)) {
    const info = await stat(filePath).catch(() => null)
    if (!info || Date.now() - info.mtimeMs <= unreadableStaleMs) return false
  }
  const current = await readFile(filePath, "utf8").catch(() => null)
  if (current !== before) return false
  await rm(filePath, { force: true }).catch(() => {})
  return true
}

function processIsAlive(pid) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}
