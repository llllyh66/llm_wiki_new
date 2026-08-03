const PAGE_KIND_DIRS = Object.freeze({
  source: "sources",
  entity: "entities",
  concept: "concepts",
  topic: "topics",
  comparison: "comparisons",
  query: "queries",
  synthesis: "synthesis",
  finding: "findings",
  methodology: "methodology",
  thesis: "thesis",
  meeting: "meetings",
  decision: "decisions",
  project: "projects",
  stakeholder: "stakeholders",
  goal: "goals",
  habit: "habits",
  reflection: "reflections",
  chapter: "chapters",
  character: "characters",
  theme: "themes",
  "plot-thread": "plot-threads",
  journal: "journal",
})

export const AGENT_PAGE_ROOTS = Object.freeze([...new Set(Object.values(PAGE_KIND_DIRS))])

export function normalizePageKind(value) {
  const normalized = String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/[\s_]+/g, "-")
  if (normalized === "comparison-page") return "comparison"
  return PAGE_KIND_DIRS[normalized] ? normalized : null
}

export function pageKindDirectory(value) {
  return PAGE_KIND_DIRS[normalizePageKind(value)] ?? null
}

export function pageKindForPath(relativePath) {
  const root = String(relativePath ?? "").replace(/\\/g, "/").split("/")[1]
  return Object.entries(PAGE_KIND_DIRS).find(([, directory]) => directory === root)?.[0] ?? null
}

export function canonicalPageSlug(value) {
  const slug = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
  return slug || "untitled"
}

export function preferredPagePath(pageKind, title) {
  const directory = pageKindDirectory(pageKind) ?? PAGE_KIND_DIRS.topic
  return `wiki/${directory}/${canonicalPageSlug(title)}.md`
}

export function parseWikiPage(content) {
  const normalized = String(content ?? "").replace(/\r\n?/g, "\n")
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/)
  const fields = {}
  if (match) {
    for (const line of match[1].split("\n")) {
      const field = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
      if (field) fields[field[1]] = field[2].trim()
    }
  }
  return {
    raw: normalized,
    frontmatter: match?.[0] ?? "",
    body: match ? normalized.slice(match[0].length) : normalized,
    fields,
    title: scalarValue(fields.title) || normalized.match(/^#\s+(.+)$/m)?.[1]?.trim() || "",
    type: scalarValue(fields.type),
    tags: arrayValue(fields.tags),
    related: arrayValue(fields.related).map(normalizeRelatedSlug).filter(Boolean),
    sources: arrayValue(fields.sources),
    covers: arrayValue(fields.covers),
    summary: scalarValue(fields.summary),
  }
}

export function prepareWikiPageContent(patch, existingContent = "", date = new Date().toISOString().slice(0, 10)) {
  const incoming = parseWikiPage(patch.content)
  const existing = parseWikiPage(existingContent)
  const pageKind = normalizePageKind(patch.pageKind) ?? pageKindForPath(patch.path) ?? "topic"
  let body = incoming.body.trim()
  if (!/^#\s+/m.test(body)) body = `# ${patch.title}\n\n${body}`.trim()
  const bodyLinks = extractWikiLinks(body)
  const related = uniqueStrings([
    ...existing.related,
    ...incoming.related,
    ...(Array.isArray(patch.related) ? patch.related : []),
    ...bodyLinks,
  ].map(normalizeRelatedSlug).filter(Boolean))
  const selfSlugs = new Set([
    canonicalPageSlug(patch.title),
    patch.path.replace(/^wiki\//, "").replace(/\.md$/i, ""),
    patch.path.split("/").pop()?.replace(/\.md$/i, ""),
  ].filter(Boolean).map(normalizeRelatedSlug))
  const sources = uniqueStrings([
    ...existing.sources,
    ...incoming.sources,
    ...patch.sourceRefs.map((ref) => ref.sourceId),
  ])
  const tags = uniqueStrings([...existing.tags, ...incoming.tags, ...(Array.isArray(patch.tags) ? patch.tags : [])])
  const covers = uniqueStrings([...existing.covers, ...incoming.covers, ...(Array.isArray(patch.covers) ? patch.covers : [])])
  const created = scalarValue(existing.fields.created) || scalarValue(incoming.fields.created) || date
  const summary = String(patch.summary ?? incoming.summary ?? existing.summary ?? firstSummary(body)).trim().slice(0, 500)
  const standard = {
    type: pageKind,
    title: patch.title,
    created,
    updated: date,
    tags,
    related: related.filter((slug) => !selfSlugs.has(slug)),
    sources,
    covers,
    summary,
  }
  const preserved = Object.entries(incoming.fields)
    .filter(([key]) => !Object.hasOwn(standard, key))
    .map(([key, value]) => `${key}: ${value}`)
  const lines = [
    "---",
    `type: ${yamlScalar(standard.type)}`,
    `title: ${yamlScalar(standard.title)}`,
    `created: ${yamlScalar(standard.created)}`,
    `updated: ${yamlScalar(standard.updated)}`,
    `tags: ${yamlArray(standard.tags)}`,
    `related: ${yamlArray(standard.related)}`,
    `sources: ${yamlArray(standard.sources)}`,
    `covers: ${yamlArray(standard.covers)}`,
    `summary: ${yamlScalar(standard.summary)}`,
    ...preserved,
    "---",
    "",
    body,
  ]
  return `${lines.join("\n").trimEnd()}\n`
}

export function setWikiPageRelated(content, related) {
  const parsed = parseWikiPage(content)
  const normalizedRelated = uniqueStrings([
    ...parsed.related,
    ...related,
  ].map(normalizeRelatedSlug).filter(Boolean))
  const relatedBody = withRelatedSection(parsed.body, normalizedRelated)
  const patch = {
    path: preferredPagePath(parsed.type || "topic", parsed.title),
    pageKind: parsed.type || "topic",
    title: parsed.title,
    content: `${parsed.frontmatter}${relatedBody}`,
    sourceRefs: parsed.sources.map((sourceId) => ({ sourceId })),
    tags: parsed.tags,
    related: normalizedRelated,
    covers: parsed.covers,
    summary: parsed.summary,
  }
  return prepareWikiPageContent(patch, content)
}

function withRelatedSection(body, related) {
  const normalizedBody = String(body ?? "").trim()
  if (related.length === 0) return normalizedBody
  const section = `## Related\n\n${related.map((slug) => `- [[${slug}]]`).join("\n")}`
  const match = normalizedBody.match(/^## Related\s*$/im)
  if (!match || match.index === undefined) return `${normalizedBody}\n\n${section}`.trim()
  const start = match.index
  const afterHeading = start + match[0].length
  const remainder = normalizedBody.slice(afterHeading)
  const nextHeading = remainder.search(/^##\s+/m)
  const end = nextHeading < 0 ? normalizedBody.length : afterHeading + nextHeading
  return `${normalizedBody.slice(0, start).trimEnd()}\n\n${section}\n\n${normalizedBody.slice(end).trimStart()}`.trim()
}

export function extractWikiLinks(content) {
  return [...String(content ?? "").matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
    .map((match) => normalizeRelatedSlug(match[1]))
    .filter(Boolean)
}

export function normalizeRelatedSlug(value) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/\\/g, "/")
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .replace(/^wiki\//i, "")
    .replace(/\.md$/i, "")
    .trim()
  return normalized.split("|")[0].trim()
}

function scalarValue(value) {
  const text = String(value ?? "").trim()
  if (!text) return ""
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try { return text.startsWith('"') ? JSON.parse(text) : text.slice(1, -1).replace(/''/g, "'") } catch { return text.slice(1, -1) }
  }
  return text
}

function arrayValue(value) {
  const text = String(value ?? "").trim()
  if (!text.startsWith("[") || !text.endsWith("]")) return []
  if (text === "[]") return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return text.slice(1, -1).split(",").map((item) => scalarValue(item)).filter(Boolean)
  }
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ""))
}

function yamlArray(values) {
  return JSON.stringify(uniqueStrings(values))
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))]
}

function firstSummary(body) {
  return body
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s+.*$/gm, "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, "$2$1").trim())
    .find(Boolean) ?? ""
}
