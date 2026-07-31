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
  const handle = await open(temp, "wx", 0o600)
  try {
    await handle.writeFile(payload, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, filePath)
}

export async function writeTextAtomic(filePath, content) {
  await ensureDir(path.dirname(filePath))
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temp, "wx", 0o600)
  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, filePath)
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
