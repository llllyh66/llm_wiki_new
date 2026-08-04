import { canonicalPageSlug } from "./wiki-page.js"
import { sha256, stableStringify } from "./utils.js"

export function buildGroundedProjectionPatches({ requirements, existingPages, analyses, targetLanguage, maxPageChars }) {
  const facts = collectRequirementFacts(requirements, analyses)
  const existingByPath = new Map((existingPages ?? []).map((page) => [page.path, page]))
  const requirementsByPath = new Map()
  for (const requirement of requirements) {
    const pagePath = requirement.patch_scaffold.path
    const grouped = requirementsByPath.get(pagePath) ?? []
    grouped.push(requirement)
    requirementsByPath.set(pagePath, grouped)
  }
  return [...requirementsByPath].map(([pagePath, grouped]) => {
    const primary = grouped[0]
    const existing = existingByPath.get(pagePath)
    const requirement = {
      ...primary,
      title: existing?.title || primary.title,
      source_refs: uniqueSourceRefs(grouped.flatMap((item) => item.source_refs)),
      related_requirements: uniqueObjects(grouped.flatMap((item) => item.related_requirements ?? [])),
      patch_scaffold: {
        ...primary.patch_scaffold,
        patchId: `patch-auto-${sha256(pagePath).slice(0, 24)}`,
        title: existing?.title || primary.patch_scaffold.title,
        covers: uniqueStrings(grouped.map((item) => item.requirement_id)),
        related: uniqueStrings(grouped.flatMap((item) => item.patch_scaffold.related ?? [])),
      },
    }
    const pageFacts = {
      candidates: uniqueObjects(grouped.flatMap((item) => facts.get(item.requirement_id)?.candidates ?? [])),
      claims: uniqueObjects(grouped.flatMap((item) => facts.get(item.requirement_id)?.claims ?? [])),
      relations: uniqueObjects(grouped.flatMap((item) => facts.get(item.requirement_id)?.relations ?? [])),
    }
    const groundedRequirement = {
      ...requirement,
      source_refs: uniqueSourceRefs([
        ...requirement.source_refs,
        ...pageFacts.candidates.flatMap((candidate) => candidate.sourceRefs ?? []),
        ...pageFacts.claims.flatMap((claim) => claim.sourceRefs ?? []),
        ...pageFacts.relations.flatMap(({ relation }) => relation.sourceRefs ?? []),
      ]),
    }
    const rendered = renderRequirementPage(groundedRequirement, pageFacts, targetLanguage, maxPageChars)
    return {
      ...groundedRequirement.patch_scaffold,
      content: rendered.content,
      summary: rendered.summary,
      tags: rendered.tags,
      // Complete, server-validated references avoid any Agent quote copying.
      sourceRefs: groundedRequirement.source_refs,
      rationale: `Deterministically project grounded analysis for ${requirement.requirement_id}.`,
    }
  })
}

export function partitionProjectionPatches(patches, maxPatches, maxCommitChars) {
  const groups = []
  let group = []
  let chars = 0
  for (const patch of patches) {
    const patchChars = patch.content.length
    if (group.length > 0 && (group.length >= maxPatches || chars + patchChars > maxCommitChars)) {
      groups.push(group)
      group = []
      chars = 0
    }
    group.push(patch)
    chars += patchChars
  }
  if (group.length > 0) groups.push(group)
  return groups
}

function collectRequirementFacts(requirements, analyses) {
  const result = new Map(requirements.map((requirement) => [requirement.requirement_id, emptyFacts()]))
  const requirementBySlug = new Map(requirements.map((requirement) => [canonicalPageSlug(requirement.title), requirement.requirement_id]))
  const requirementMatcher = buildRequirementMatcher(requirements)

  for (const analysis of analyses) {
    const localRequirements = new Map()
    for (const [collection, candidates] of [
      ["entity", analysis.entities],
      ["concept", analysis.concepts],
      ["candidate-page", analysis.candidatePages],
    ]) {
      for (const candidate of candidates ?? []) {
        const title = candidateTitle(candidate)
        const requirementId = requirementBySlug.get(canonicalPageSlug(title))
        if (!requirementId) continue
        const localId = candidate.localId ?? candidate.local_id
        if (typeof localId === "string" && localId) localRequirements.set(localId, requirementId)
        result.get(requirementId).candidates.push({ ...candidate, collection, batchId: analysis.batchId })
      }
    }

    for (const claim of analysis.claims ?? []) {
      const text = candidateText(claim)
      const explicitIds = [claim.subject, claim.source, claim.entity, claim.title, claim.name]
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => requirementBySlug.get(canonicalPageSlug(value)))
        .filter(Boolean)
      const matchedIds = uniqueStrings([...explicitIds, ...requirementMatcher(text)])
      for (const requirementId of matchedIds) result.get(requirementId)?.claims.push(claim)
    }

    for (const relation of analysis.relations ?? []) {
      const sourceLocalId = relation.sourceEntityLocalId ?? relation.source_entity_local_id ?? relation.sourceLocalId
      const targetLocalId = relation.targetEntityLocalId ?? relation.target_entity_local_id ?? relation.targetLocalId
      const sourceRequirementId = (sourceLocalId && localRequirements.get(sourceLocalId))
        ?? requirementBySlug.get(canonicalPageSlug(relation.source ?? relation.from ?? relation.subject))
      const targetRequirementId = (targetLocalId && localRequirements.get(targetLocalId))
        ?? requirementBySlug.get(canonicalPageSlug(relation.target ?? relation.to ?? relation.object))
      if (sourceRequirementId) result.get(sourceRequirementId).relations.push({ relation, counterpartRequirementId: targetRequirementId })
      if (targetRequirementId && targetRequirementId !== sourceRequirementId) {
        result.get(targetRequirementId).relations.push({ relation, counterpartRequirementId: sourceRequirementId })
      }
    }
  }

  for (const item of result.values()) {
    item.candidates = uniqueObjects(item.candidates)
    item.claims = uniqueObjects(item.claims)
    item.relations = uniqueObjects(item.relations)
  }
  return result
}

function renderRequirementPage(requirement, facts, targetLanguage, maxPageChars) {
  const chinese = String(targetLanguage ?? "").toLowerCase().startsWith("zh")
  const labels = chinese
    ? { overview: "概述", properties: "属性", facts: "关键事实", relations: "关系", evidence: "来源证据", related: "Related", type: "类型" }
    : { overview: "Overview", properties: "Properties", facts: "Key facts", relations: "Relationships", evidence: "Source evidence", related: "Related", type: "Type" }
  const requirementByRelatedId = new Map((requirement.related_requirements ?? []).map((item) => [item.requirement_id, item]))
  const candidateStatements = uniqueStrings(facts.candidates.map(candidateText).filter((text) => text && canonicalPageSlug(text) !== canonicalPageSlug(requirement.title)))
  const claimStatements = uniqueStrings(facts.claims.map(candidateText).filter(Boolean))
  const evidence = uniqueSourceRefs(requirement.source_refs).slice(0, 50)
  const evidenceStatements = uniqueStrings(evidence.map((ref) => ref.quote).filter(Boolean))
  const overview = candidateStatements[0] ?? claimStatements[0] ?? evidenceStatements[0] ?? requirement.title
  const properties = collectProperties(facts.candidates)
  const entityTypes = uniqueStrings(facts.candidates.map((candidate) => candidate.entityTypeId).filter(Boolean))
  const relatedSlugs = uniqueStrings([
    ...(requirement.patch_scaffold?.related ?? []),
    ...facts.relations.map(({ counterpartRequirementId }) => requirementByRelatedId.get(counterpartRequirementId)?.slug).filter(Boolean),
  ])

  const sections = [`# ${escapeMarkdown(requirement.title)}`, `## ${labels.overview}\n\n${escapeMarkdown(overview)}`]
  if (entityTypes.length > 0 || properties.length > 0) {
    const rows = []
    if (entityTypes.length > 0) rows.push(`| ${labels.type} | ${entityTypes.map(escapeTableCell).join(", ")} |`)
    for (const property of properties.slice(0, 100)) rows.push(`| ${escapeTableCell(property.key)} | ${escapeTableCell(property.value)} |`)
    sections.push(`## ${labels.properties}\n\n| ${chinese ? "字段" : "Field"} | ${chinese ? "值" : "Value"} |\n| --- | --- |\n${rows.join("\n")}`)
  }
  const statements = uniqueStrings([...candidateStatements.slice(1), ...claimStatements]).slice(0, 100)
  if (statements.length > 0) sections.push(`## ${labels.facts}\n\n${statements.map((text) => `- ${escapeMarkdown(text)}`).join("\n")}`)
  const relationLines = uniqueStrings(facts.relations.map(({ relation, counterpartRequirementId }) => {
    const text = candidateText(relation) || relation.relationTypeId || relation.name
    if (!text) return ""
    const related = requirementByRelatedId.get(counterpartRequirementId)
    return related ? `${escapeMarkdown(text)} ([[${related.slug}|${related.title}]])` : escapeMarkdown(text)
  }).filter(Boolean)).slice(0, 100)
  if (relationLines.length > 0) sections.push(`## ${labels.relations}\n\n${relationLines.map((text) => `- ${text}`).join("\n")}`)
  if (evidence.length > 0) {
    const lines = evidence.map((ref) => {
      const location = [ref.sourceId, ref.chunkId].filter(Boolean).join(" / ")
      return ref.quote ? `- ${escapeMarkdown(ref.quote)} _(${escapeMarkdown(location)})_` : `- ${escapeMarkdown(location)}`
    })
    sections.push(`## ${labels.evidence}\n\n${lines.join("\n")}`)
  }
  if (relatedSlugs.length > 0) sections.push(`## ${labels.related}\n\n${relatedSlugs.map((slug) => `- [[${slug}]]`).join("\n")}`)

  let content = `${sections.join("\n\n")}\n`
  if (content.length > maxPageChars) content = `${content.slice(0, Math.max(1, maxPageChars - 2)).trimEnd()}\n`
  return {
    content,
    summary: overview.slice(0, 500),
    tags: uniqueStrings([requirement.page_kind, ...entityTypes]).slice(0, 100),
  }
}

function emptyFacts() {
  return { candidates: [], claims: [], relations: [] }
}

function candidateTitle(candidate) {
  return String(candidate?.title ?? candidate?.name ?? "").normalize("NFKC").trim()
}

function candidateText(candidate) {
  return String(candidate?.content ?? candidate?.text ?? candidate?.description ?? "").normalize("NFKC").trim()
}

function buildRequirementMatcher(requirements) {
  const prefixes = new Map()
  for (const requirement of requirements) {
    const title = String(requirement.title ?? "").normalize("NFKC").trim().toLowerCase()
    if (title.length < 2) continue
    const prefix = title.slice(0, 2)
    const candidates = prefixes.get(prefix) ?? []
    candidates.push({ requirementId: requirement.requirement_id, title })
    prefixes.set(prefix, candidates)
  }
  return (text) => {
    const normalized = String(text ?? "").normalize("NFKC").toLowerCase()
    const matches = new Set()
    const visitedPrefixes = new Set()
    for (let index = 0; index < normalized.length - 1; index += 1) {
      const prefix = normalized.slice(index, index + 2)
      if (visitedPrefixes.has(prefix)) continue
      visitedPrefixes.add(prefix)
      for (const candidate of prefixes.get(prefix) ?? []) {
        if (normalized.includes(candidate.title)) matches.add(candidate.requirementId)
      }
    }
    return [...matches]
  }
}

function collectProperties(candidates) {
  const values = new Map()
  for (const candidate of candidates) {
    if (!candidate.properties || typeof candidate.properties !== "object" || Array.isArray(candidate.properties)) continue
    for (const [key, value] of Object.entries(candidate.properties)) {
      const rendered = renderValue(value)
      if (!rendered) continue
      const existing = values.get(key) ?? []
      values.set(key, uniqueStrings([...existing, rendered]))
    }
  }
  return [...values].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({ key, value: value.join("; ") }))
}

function renderValue(value) {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value.trim()
  if (["number", "boolean", "bigint"].includes(typeof value)) return String(value)
  try { return JSON.stringify(value) } catch { return String(value) }
}

function uniqueSourceRefs(refs) {
  const seen = new Set()
  return (refs ?? []).filter((ref) => {
    const key = stableStringify(ref)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueObjects(values) {
  const seen = new Set()
  return values.filter((value) => {
    const key = sha256(stableStringify(value))
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))]
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_[\]<>])/g, "\\$1").replace(/\r?\n/g, " ").trim()
}

function escapeTableCell(value) {
  return escapeMarkdown(value).replace(/\|/g, "\\|")
}
