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
    domainSchemaId: scalarValue(fields.domain_schema_id),
    domainSchemaVersion: scalarValue(fields.domain_schema_version),
    domainTypeKinds: arrayValue(fields.domain_type_kinds),
    domainTypeIds: arrayValue(fields.domain_type_ids),
    domainTypeNames: arrayValue(fields.domain_type_names),
    schemaLayout: scalarValue(fields.schema_layout),
    schemaSnapshotHash: scalarValue(fields.schema_snapshot_hash),
    schemaClassificationStatus: scalarValue(fields.schema_classification_status),
    schemaDomainKeys: arrayValue(fields.schema_domain_keys),
    schemaDomainNames: arrayValue(fields.schema_domain_names),
    schemaAbeKeys: arrayValue(fields.schema_abe_keys),
    schemaAbeNames: arrayValue(fields.schema_abe_names),
    schemaBeKeys: arrayValue(fields.schema_be_keys),
    schemaBeNames: arrayValue(fields.schema_be_names),
    schemaClassificationPaths: arrayValue(fields.schema_classification_paths),
  }
}

export function listWikiPageSections(content) {
  const parsed = parseWikiPage(content)
  return markdownSectionRanges(parsed.body).map((section) => ({
    heading: section.heading,
    level: section.level,
    content: parsed.body.slice(section.bodyStart, section.end).trim(),
  }))
}

export function readWikiPageSection(content, heading) {
  const parsed = parseWikiPage(content)
  const matches = markdownSectionRanges(parsed.body)
    .filter((section) => normalizedSectionHeading(section.heading) === normalizedSectionHeading(heading))
  if (matches.length !== 1) return { found: false, ambiguous: matches.length > 1, heading: String(heading ?? "").trim() }
  const section = matches[0]
  return {
    found: true,
    ambiguous: false,
    heading: section.heading,
    level: section.level,
    content: parsed.body.slice(section.bodyStart, section.end).trim(),
  }
}

export function applyWikiPageSectionChanges(content, changes) {
  const parsed = parseWikiPage(content)
  let body = parsed.body.trim()
  const changedSections = []
  for (const change of changes) {
    const operation = String(change?.operation ?? "").trim()
    const heading = String(change?.heading ?? "").normalize("NFKC").trim()
    const level = Number.isInteger(change?.level) ? change.level : 2
    const sectionContent = String(change?.content ?? "").replace(/\r\n?/g, "\n").trim()
    const matches = markdownSectionRanges(body)
      .filter((section) => normalizedSectionHeading(section.heading) === normalizedSectionHeading(heading))
    if (matches.length > 1) throw sectionChangeError("WIKI_SECTION_AMBIGUOUS", `Section heading is duplicated: ${heading}`)
    const section = matches[0]
    if (["replace_section", "append_to_section", "remove_section"].includes(operation) && !section) {
      throw sectionChangeError("WIKI_SECTION_NOT_FOUND", `Section does not exist: ${heading}`)
    }
    if (!new Set(["upsert_section", "replace_section", "append_to_section", "remove_section"]).has(operation)) {
      throw sectionChangeError("INVALID_WIKI_UPDATE", `Unsupported section operation: ${operation}`)
    }
    if (operation !== "remove_section" && !sectionContent) {
      throw sectionChangeError("INVALID_WIKI_UPDATE", `Section content is required for ${operation}: ${heading}`)
    }
    if (operation === "upsert_section" && !section) {
      const appended = `${"#".repeat(level)} ${heading}\n\n${sectionContent}`
      body = joinMarkdownRanges(body, appended, "")
    } else if (operation === "replace_section" || operation === "upsert_section") {
      const replacement = `${"#".repeat(section.level)} ${section.heading}\n\n${sectionContent}`
      body = joinMarkdownRanges(body.slice(0, section.start), replacement, body.slice(section.end))
    } else if (operation === "append_to_section") {
      const current = body.slice(section.start, section.end).trimEnd()
      body = joinMarkdownRanges(body.slice(0, section.start), `${current}\n\n${sectionContent}`, body.slice(section.end))
    } else {
      body = joinMarkdownRanges(body.slice(0, section.start), "", body.slice(section.end))
    }
    changedSections.push({ operation, heading, level: section?.level ?? level })
  }
  return {
    content: `${parsed.frontmatter}${body.trim()}\n`,
    changed_sections: changedSections,
    sections: listWikiPageSections(`${parsed.frontmatter}${body}`),
  }
}

function markdownSectionRanges(body) {
  const normalized = String(body ?? "").replace(/\r\n?/g, "\n")
  const lines = normalized.split(/(?<=\n)/)
  const headings = []
  let offset = 0
  let fence = null
  for (const lineWithEnding of lines) {
    const line = lineWithEnding.replace(/\n$/, "")
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})\s*.*$/)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length) fence = null
      offset += lineWithEnding.length
      continue
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length }
      offset += lineWithEnding.length
      continue
    }
    const heading = line.match(/^ {0,3}(#{2,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/)
    if (heading) {
      headings.push({
        heading: heading[2].trim(),
        level: heading[1].length,
        start: offset,
        bodyStart: offset + lineWithEnding.length,
        end: normalized.length,
      })
    }
    offset += lineWithEnding.length
  }
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index]
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= current.level)
    current.end = next?.start ?? normalized.length
  }
  return headings
}

function normalizedSectionHeading(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
}

function joinMarkdownRanges(before, middle, after) {
  return [String(before ?? "").trimEnd(), String(middle ?? "").trim(), String(after ?? "").trimStart()]
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

function sectionChangeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function prepareWikiPageContent(patch, existingContent = "", date = new Date().toISOString().slice(0, 10)) {
  const incoming = parseWikiPage(patch.content)
  const existing = parseWikiPage(existingContent)
  const pageKind = normalizePageKind(patch.pageKind) ?? pageKindForPath(patch.path) ?? "topic"
  let body = incoming.body.trim()
  if (!/^#\s+/m.test(body)) body = `# ${patch.title}\n\n${body}`.trim()
  if (patch.operation === "merge" && existing.body.trim() && existing.body.trim() !== body) {
    // replace is intentionally authoritative for the incoming body. Merge is
    // the explicit opt-in for retaining the existing grounded body; callers
    // still provide the current file hash so this concatenation cannot race a
    // concurrent edit.
    body = `${existing.body.trim()}\n\n${body}`.trim()
  }
  const bodyLinks = extractRelatedReferences(body)
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
  const incomingDomain = domainClassificationsFromPage(incoming)
  const existingDomain = domainClassificationsFromPage(existing)
  const patchDomain = normalizeDomainClassifications(patch.domainClassifications)
  // When Core supplies domainClassifications, it is authoritative: the page
  // must not retain a stale or model-invented type from the incoming body.
  // For legacy patches that omit the field, preserve existing metadata.
  const domainClassifications = Array.isArray(patch.domainClassifications)
    ? patchDomain
    : uniqueDomainClassifications([...existingDomain, ...incomingDomain])
  const domainSchemaId = String(patch.domainSchemaId ?? incoming.domainSchemaId ?? existing.domainSchemaId ?? domainClassifications[0]?.schemaId ?? "").trim()
  const domainSchemaVersion = String(patch.domainSchemaVersion ?? incoming.domainSchemaVersion ?? existing.domainSchemaVersion ?? domainClassifications[0]?.schemaVersion ?? "").trim()
  const normalizedRelated = related.filter((slug) => !selfSlugs.has(slug))
  body = withRelatedSection(body, normalizedRelated)
  body = withDomainClassificationSection(body, domainClassifications)
  const standard = {
    type: pageKind,
    title: patch.title,
    created,
    updated: date,
    tags,
    related: normalizedRelated,
    sources,
    covers,
    summary,
  }
  if (domainSchemaId) standard.domain_schema_id = domainSchemaId
  if (domainSchemaVersion) standard.domain_schema_version = domainSchemaVersion
  if (domainClassifications.length > 0) {
    standard.domain_type_kinds = domainClassifications.map((item) => item.kind)
    standard.domain_type_ids = domainClassifications.map((item) => item.typeId)
    standard.domain_type_names = domainClassifications.map((item) => item.typeName)
    const progressive = domainClassifications.filter((item) => item.schemaMode === "progressive-directory-v2")
    if (progressive.length > 0) {
      standard.schema_layout = "progressive-directory-v2"
      standard.schema_snapshot_hash = progressive.find((item) => item.schemaId)?.schemaId ?? ""
      standard.schema_classification_status = progressive.some((item) => item.status === "unresolved" || item.resolved === false) ? "unresolved" : "classified"
      standard.schema_domain_keys = progressive.map((item) => item.domain?.key).filter(Boolean)
      standard.schema_domain_names = progressive.map((item) => item.domain?.name).filter(Boolean)
      standard.schema_abe_keys = progressive.map((item) => item.abe?.key).filter(Boolean)
      standard.schema_abe_names = progressive.map((item) => item.abe?.name).filter(Boolean)
      standard.schema_be_keys = progressive.map((item) => item.be?.key).filter(Boolean)
      standard.schema_be_names = progressive.map((item) => item.be?.name).filter(Boolean)
      standard.schema_classification_paths = progressive.map((item) => [item.domain?.key, item.abe?.key, item.be?.key].filter(Boolean).join("/"))
    }
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
    ...(standard.domain_schema_id ? [`domain_schema_id: ${yamlScalar(standard.domain_schema_id)}`] : []),
    ...(standard.domain_schema_version ? [`domain_schema_version: ${yamlScalar(standard.domain_schema_version)}`] : []),
    ...(standard.domain_type_kinds ? [`domain_type_kinds: ${yamlArray(standard.domain_type_kinds)}`] : []),
    ...(standard.domain_type_ids ? [`domain_type_ids: ${yamlArray(standard.domain_type_ids)}`] : []),
    ...(standard.domain_type_names ? [`domain_type_names: ${yamlArray(standard.domain_type_names)}`] : []),
    ...(standard.schema_layout ? [`schema_layout: ${yamlScalar(standard.schema_layout)}`] : []),
    ...(standard.schema_snapshot_hash ? [`schema_snapshot_hash: ${yamlScalar(standard.schema_snapshot_hash)}`] : []),
    ...(standard.schema_classification_status ? [`schema_classification_status: ${yamlScalar(standard.schema_classification_status)}`] : []),
    ...(standard.schema_domain_keys ? [`schema_domain_keys: ${yamlArray(standard.schema_domain_keys)}`] : []),
    ...(standard.schema_domain_names ? [`schema_domain_names: ${yamlArray(standard.schema_domain_names)}`] : []),
    ...(standard.schema_abe_keys ? [`schema_abe_keys: ${yamlArray(standard.schema_abe_keys)}`] : []),
    ...(standard.schema_abe_names ? [`schema_abe_names: ${yamlArray(standard.schema_abe_names)}`] : []),
    ...(standard.schema_be_keys ? [`schema_be_keys: ${yamlArray(standard.schema_be_keys)}`] : []),
    ...(standard.schema_be_names ? [`schema_be_names: ${yamlArray(standard.schema_be_names)}`] : []),
    ...(standard.schema_classification_paths ? [`schema_classification_paths: ${yamlArray(standard.schema_classification_paths)}`] : []),
    ...preserved,
    "---",
    "",
    body,
  ]
  return `${lines.join("\n").trimEnd()}\n`
}

function domainClassificationsFromPage(page) {
  if (page.schemaLayout === "progressive-directory-v2") {
    const count = Math.max(page.schemaBeKeys.length, page.schemaAbeKeys.length, page.schemaDomainKeys.length, 1)
    return uniqueDomainClassifications(Array.from({ length: count }, (_, index) => ({
      kind: page.domainTypeKinds[index] || "entity",
      typeId: page.schemaBeKeys[index] || page.schemaAbeKeys[index] || page.schemaDomainKeys[index] || "unresolved",
      typeName: page.schemaBeNames[index] || page.schemaAbeNames[index] || page.schemaDomainNames[index] || "待分类",
      schemaId: page.schemaSnapshotHash || page.domainSchemaId,
      schemaVersion: page.domainSchemaVersion || "2",
      schemaMode: "progressive-directory-v2",
      status: page.schemaClassificationStatus || "classified",
      domain: { key: page.schemaDomainKeys[index] || "", name: page.schemaDomainNames[index] || "" },
      abe: { key: page.schemaAbeKeys[index] || "", name: page.schemaAbeNames[index] || "" },
      be: { key: page.schemaBeKeys[index] || "", name: page.schemaBeNames[index] || "" },
      ...(page.schemaClassificationStatus === "unresolved" ? { resolved: false } : {}),
    })))
  }
  const ids = page.domainTypeIds ?? []
  const names = page.domainTypeNames ?? []
  const kinds = page.domainTypeKinds ?? []
  return uniqueDomainClassifications(ids.map((typeId, index) => ({
    kind: kinds[index] || "entity",
    typeId,
    typeName: names[index] || typeId,
    schemaId: page.domainSchemaId,
    schemaVersion: page.domainSchemaVersion,
  })))
}

function normalizeDomainClassifications(values) {
  if (!Array.isArray(values)) return []
  return uniqueDomainClassifications(values.map((item) => ({
    kind: String(item?.kind ?? "entity").trim().toLowerCase() || "entity",
    typeId: String(item?.typeId ?? item?.type_id ?? "").trim(),
    typeName: String(item?.typeName ?? item?.type_name ?? item?.typeId ?? item?.type_id ?? "").trim(),
    schemaId: String(item?.schemaId ?? item?.schema_id ?? "").trim(),
    schemaVersion: String(item?.schemaVersion ?? item?.schema_version ?? "").trim(),
    ...(item?.schemaMode ? { schemaMode: String(item.schemaMode).trim() } : {}),
    ...(item?.status ? { status: String(item.status).trim() } : {}),
    ...(item?.confidence !== undefined ? { confidence: Number(item.confidence) } : {}),
    ...(item?.domain ? { domain: item.domain } : {}),
    ...(item?.abe ? { abe: item.abe } : {}),
    ...(item?.be ? { be: item.be } : {}),
    ...(item?.resolved === false ? { resolved: false } : {}),
  })).filter((item) => item.typeId && item.typeName))
}

function uniqueDomainClassifications(values) {
  const seen = new Set()
  return values.filter((item) => {
    if (!item?.typeId || !item?.typeName) return false
    const key = `${item.kind}:${item.typeId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function withDomainClassificationSection(body, classifications) {
  const normalizedBody = String(body ?? "").trim()
  const headings = /^#{2,6}\s+(?:Domain Classification|领域分类|领域类型)\s*$/im
  const match = normalizedBody.match(headings)
  if (classifications.length === 0) return normalizedBody
  const language = classifications.some((item) => /[\u3400-\u9fff]/u.test(item.typeName)) ? "zh" : "en"
  const heading = language === "zh" ? "## 领域分类" : "## Domain Classification"
  const progressive = classifications.some((item) => item.schemaMode === "progressive-directory-v2")
  const lines = progressive
    ? classifications.map((item) => {
      const unresolved = item.status === "unresolved" || item.resolved === false ? "（待分类）" : ""
      const domain = item.domain?.name || item.domain?.key || "未知 Domain"
      const abe = item.abe?.name || item.abe?.key || "待分类 ABE"
      const be = item.be?.name || item.be?.key || "待分类 BE"
      return `- Domain：${domain}（\`${item.domain?.key || "?"}\`） → ABE：${abe}（\`${item.abe?.key || "?"}\`） → BE：${be}（\`${item.be?.key || "?"}\`）${unresolved}`
    })
    : classifications.map((item) => {
    const unresolved = item.resolved === false ? "（未解析）" : ""
    return `- ${item.typeName}（\`${item.typeId}\`）${unresolved}`
    })
  const section = `${heading}\n\n${lines.join("\n")}`
  if (!match || match.index === undefined) return `${normalizedBody}\n\n${section}`.trim()
  const afterHeading = match.index + match[0].length
  const remainder = normalizedBody.slice(afterHeading)
  const nextHeading = remainder.search(/^#{1,6}\s+/m)
  const end = nextHeading < 0 ? normalizedBody.length : afterHeading + nextHeading
  return `${normalizedBody.slice(0, match.index).trimEnd()}\n\n${section}\n\n${normalizedBody.slice(end).trimStart()}`.trim()
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
  const match = normalizedBody.match(/^#{2,6}\s+(?:Related(?:\s+Pages?)?|相关页面|关联页面)\s*$/im)
  if (!match || match.index === undefined) return `${normalizedBody}\n\n${section}`.trim()
  const start = match.index
  const afterHeading = start + match[0].length
  const remainder = normalizedBody.slice(afterHeading)
  const nextHeading = remainder.search(/^##\s+/m)
  const end = nextHeading < 0 ? normalizedBody.length : afterHeading + nextHeading
  return `${normalizedBody.slice(0, start).trimEnd()}\n\n${section}\n\n${normalizedBody.slice(end).trimStart()}`.trim()
}

export function extractWikiLinks(content) {
  return [...maskMarkdownContexts(String(content ?? "")).matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
    .map((match) => normalizeRelatedSlug(match[1]))
    .filter(Boolean)
}

// Page authors and older Writer prompts have emitted three equivalent link
// forms over time. Accept all of them at the deterministic Core boundary, but
// only treat plain paths as relationships inside an explicit Related section.
// This avoids turning incidental source-file mentions into graph edges.
export function extractRelatedReferences(content) {
  const text = String(content ?? "").replace(/\r\n?/g, "\n")
  const relationshipText = maskMarkdownContexts(text)
  const references = [...relationshipText.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
    .map((match) => normalizeRelatedSlug(match[1]))
    .filter(Boolean)

  for (const match of relationshipText.matchAll(/\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
    const slug = canonicalRelatedPath(match[1])
    if (slug) references.push(slug)
  }

  const section = relatedSectionBody(relationshipText)
  for (const line of section.split("\n")) {
    const item = line.match(/^\s*[-*+]\s+(.+?)\s*$/)?.[1]
    if (!item || /^\[\[/.test(item) || /^\[[^\]]*\]\(/.test(item)) continue
    const slug = canonicalRelatedPath(item)
    if (slug) references.push(slug)
  }

  return uniqueStrings(references.map(normalizeRelatedSlug).filter(Boolean))
}

function maskMarkdownContexts(content) {
  const normalized = String(content ?? "").replace(/\r\n?/g, "\n")
  let masked = normalized
    .replace(/<!--[\s\S]*?-->/g, (value) => value.replace(/[^\n]/g, " "))
    .replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, (value) => value.replace(/[^\n]/g, " "))
  const lines = masked.split(/(?<=\n)/)
  const originalLines = normalized.split(/(?<=\n)/)
  let fence = null
  let frontmatter = originalLines[0]?.trim() === "---"
  for (let index = 0; index < lines.length; index += 1) {
    const original = originalLines[index] ?? ""
    const line = lines[index] ?? ""
    if (frontmatter) {
      lines[index] = blankMarkdownLine(line)
      if (index > 0 && original.trim() === "---") frontmatter = false
      continue
    }
    const fenceMatch = original.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      lines[index] = blankMarkdownLine(line)
      if (new RegExp(`^ {0,3}${fence}{3,}\\s*$`).test(original)) fence = null
      continue
    }
    if (fenceMatch) {
      lines[index] = blankMarkdownLine(line)
      fence = fenceMatch[1][0]
      continue
    }
    if (/^(?: {4}|\t)/.test(original) || /^\s*>/.test(original)) {
      lines[index] = blankMarkdownLine(line)
      continue
    }
    lines[index] = line.replace(/(`+)[^`\n]*?\1/g, (value) => value.replace(/[^\n]/g, " "))
  }
  return lines.join("")
}

function blankMarkdownLine(value) {
  return String(value).replace(/[^\n]/g, " ")
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

function canonicalRelatedPath(value) {
  let candidate = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/^`|`$/g, "")
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/^\.\//, "")
  if (!candidate || /^[a-z][a-z\d+.-]*:/i.test(candidate) || candidate.includes(" ")) return ""
  if (candidate.toLowerCase().startsWith("wiki/")) candidate = candidate.slice(5)
  const [root, ...rest] = candidate.split("/")
  const normalizedRoot = root.toLowerCase()
  if (!AGENT_PAGE_ROOTS.includes(normalizedRoot)
    || rest.length === 0
    || rest.some((segment) => !segment || segment === "." || segment === "..")) return ""
  return normalizeRelatedSlug([normalizedRoot, ...rest].join("/"))
}

function relatedSectionBody(content) {
  const heading = String(content ?? "").match(/^#{2,6}\s+(?:Related(?:\s+Pages?)?|相关页面|关联页面)\s*$/im)
  if (!heading || heading.index === undefined) return ""
  const start = heading.index + heading[0].length
  const remainder = content.slice(start)
  const nextHeading = remainder.search(/^#{1,6}\s+/m)
  return nextHeading < 0 ? remainder : remainder.slice(0, nextHeading)
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
