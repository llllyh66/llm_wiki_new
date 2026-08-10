import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"
import { pathExists, readJson, sha256, stableStringify } from "./utils.js"
import {
  PROGRESSIVE_SCHEMA_MODE,
  applyProgressiveSchema,
  isProgressiveSchema,
  loadProgressiveSchemaSnapshot,
  progressiveSchemaDisclosure,
  progressiveSchemaMetadata,
  resolveProgressiveSchemaDirectory,
} from "./schema-bundle.js"

const MAX_DOMAIN_SCHEMA_BYTES = 5 * 1024 * 1024
const VALUE_TYPES = new Set(["string", "number", "integer", "boolean", "date", "datetime", "json"])
const EXTRACTION_MODES = new Set(["strict", "compatible"])
const FAILURE_POLICIES = new Set(["reject-batch", "drop-invalid"])
const INLINE_DOMAIN_SCHEMA_BYTES = 64 * 1024
const MAX_DOMAIN_SCHEMA_ITEM_BYTES = 80 * 1024
const domainSchemaMatchIndexCache = new WeakMap()
const domainSchemaRuntimeCache = new WeakMap()
const propertyLookupCache = new WeakMap()

export async function resolveDomainSchema(workspace, options = {}) {
  options = options ?? {}
  const inline = options.domain_schema ?? options.domainSchema
  const configuredPath = options.domain_schema_path ?? options.domainSchemaPath
  if (inline !== undefined && configuredPath) fail("INVALID_DOMAIN_SCHEMA", "Provide either domain_schema or domain_schema_path, not both.")
  if (inline !== undefined) return domainSchemaRecord(inline)
  const schemaPath = configuredPath ? path.resolve(workspace.paths.root, configuredPath) : path.join(workspace.paths.root, "llm-wiki.domain-schema.json")
  if (!configuredPath && !(await pathExists(schemaPath))) return null
  let info
  try {
    info = await lstat(schemaPath)
  } catch {
    fail("INVALID_DOMAIN_SCHEMA", "The configured domain schema file is not readable.")
  }
  if (info.isDirectory()) {
    const bundle = await resolveProgressiveSchemaDirectory(schemaPath)
    return { schema: bundle, metadata: progressiveSchemaMetadata(bundle), bundle }
  }
  if (!info.isFile() || info.isSymbolicLink()) fail("INVALID_DOMAIN_SCHEMA", "The domain schema must be a regular JSON file or progressive Schema directory, not a symbolic link.")
  if (info.size > MAX_DOMAIN_SCHEMA_BYTES) fail("INVALID_DOMAIN_SCHEMA", `The domain schema exceeds ${MAX_DOMAIN_SCHEMA_BYTES} bytes.`)
  let parsed
  try {
    parsed = JSON.parse(await readFile(schemaPath, "utf8"))
  } catch {
    fail("INVALID_DOMAIN_SCHEMA", "The domain schema is not valid UTF-8 JSON.")
  }
  return domainSchemaRecord(parsed)
}

export async function loadTaskDomainSchema(record) {
  if (!record.task.domainSchema) return null
  if (record.task.domainSchema.schema_mode === PROGRESSIVE_SCHEMA_MODE || record.task.domainSchema.mode === PROGRESSIVE_SCHEMA_MODE) {
    return loadProgressiveSchemaSnapshot(record)
  }
  const schema = await readJson(record.paths.domainSchema)
  // Tasks created before V1.0.1 do not have the optional conceptTypes array.
  // Normalize that missing field at the read boundary so all downstream
  // selection and projection code remains backward compatible.
  return { ...schema, conceptTypes: Array.isArray(schema?.conceptTypes) ? schema.conceptTypes : [] }
}

export { progressiveSchemaDisclosure }

export function domainSchemaContext(schema, inlineBytes = INLINE_DOMAIN_SCHEMA_BYTES, knownBytes) {
  if (!schema) return { value: null, pagination: null }
  if (isProgressiveSchema(schema)) {
    return {
      value: {
        mode: PROGRESSIVE_SCHEMA_MODE,
        schemaId: schema.schemaId,
        schemaVersion: schema.schemaVersion,
        rootFile: schema.manifest.root_file,
        fileCount: schema.manifest.file_count,
        totalBytes: schema.manifest.total_bytes,
        disclosureTool: "llm_wiki_get_domain_schema",
      },
      pagination: {
        required: true,
        mode: "progressive-levels",
        tool: "llm_wiki_get_domain_schema",
        first_level: "domains",
        full_file_exposure: true,
      },
    }
  }
  const bytes = Number.isInteger(knownBytes) && knownBytes >= 0
    ? knownBytes
    : Buffer.byteLength(JSON.stringify(schema))
  if (bytes <= inlineBytes) return { value: schema, pagination: null }
  return {
    value: {
      formatVersion: schema.formatVersion,
      schemaId: schema.schemaId,
      schemaVersion: schema.schemaVersion,
      name: schema.name,
      description: schema.description,
      language: schema.language,
      policy: schema.policy,
      entityTypeCount: schema.entityTypes.length,
      conceptTypeCount: schema.conceptTypes.length,
      relationTypeCount: schema.relationTypes.length,
      inline: false,
      totalBytes: bytes,
    },
    pagination: {
      required: true,
      cursor: 0,
      tool: "llm_wiki_get_domain_schema",
      recommended_mode: "search",
      recommended_max_matches: 12,
      fallback_modes: ["catalog", "types"],
      full_scan_required: false,
    },
  }
}

export function compactDomainSchemaSelectionForText(schema, text, maxBytes = 6 * 1024) {
  const matched = matchDomainSchemaTypesForText(schema, text, 12)
  if (matched.entityTypeIds.length === 0 && matched.conceptTypeIds.length === 0 && matched.relationTypeIds.length === 0) {
    return {
      ready: false,
      mode: "batch-text-compact",
      matched_terms: [],
      reason: "No canonical type, alias, or property label matched the batch text.",
    }
  }
  const entityIds = new Set(matched.entityTypeIds)
  const conceptIds = new Set(matched.conceptTypeIds ?? [])
  const relationIds = new Set(matched.relationTypeIds)
  for (const relation of schema.relationTypes) {
    if (!relationIds.has(relation.id)) continue
    relation.sourceEntityTypeIds.forEach((id) => entityIds.add(id))
    relation.targetEntityTypeIds.forEach((id) => entityIds.add(id))
  }
  const compactProperty = (property) => ({
    id: property.id,
    name: property.name,
    ...(property.aliases.length > 0 ? { aliases: property.aliases } : {}),
    valueType: property.valueType,
    required: property.required,
    unique: property.unique,
  })
  const candidates = [
    {
      kind: "schema",
      schema: {
        schemaId: schema.schemaId,
        schemaVersion: schema.schemaVersion,
        language: schema.language,
        policy: schema.policy,
      },
    },
    ...schema.entityTypes.filter((type) => entityIds.has(type.id)).map((type) => ({
      kind: "entity_type",
      entity_type: {
        id: type.id,
        name: type.name,
        ...(type.aliases.length > 0 ? { aliases: type.aliases } : {}),
        properties: type.properties.map(compactProperty),
      },
    })),
    ...schema.conceptTypes.filter((type) => conceptIds.has(type.id)).map((type) => ({
      kind: "concept_type",
      concept_type: {
        id: type.id,
        name: type.name,
        ...(type.aliases.length > 0 ? { aliases: type.aliases } : {}),
        properties: type.properties.map(compactProperty),
      },
    })),
    ...schema.relationTypes.filter((type) => relationIds.has(type.id)).map((type) => ({
      kind: "relation_type",
      relation_type: {
        id: type.id,
        name: type.name,
        ...(type.aliases.length > 0 ? { aliases: type.aliases } : {}),
        sourceEntityTypeIds: type.sourceEntityTypeIds,
        targetEntityTypeIds: type.targetEntityTypeIds,
        properties: type.properties.map(compactProperty),
      },
    })),
  ]
  const items = []
  let usedBytes = 0
  for (const item of candidates) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item))
    if (usedBytes + itemBytes > maxBytes) break
    items.push(item)
    usedBytes += itemBytes
  }
  const includedEntityIds = items.filter((item) => item.kind === "entity_type").map((item) => item.entity_type.id)
  const includedRelationIds = items.filter((item) => item.kind === "relation_type").map((item) => item.relation_type.id)
  const includedConceptIds = items.filter((item) => item.kind === "concept_type").map((item) => item.concept_type.id)
  const complete = includedEntityIds.length === entityIds.size && includedConceptIds.length === conceptIds.size && includedRelationIds.length === relationIds.size
  return {
    ready: complete,
    mode: "batch-text-compact",
    matcher: matched.matcher,
    matched_terms: matched.matchedTerms,
    selection: {
      mode: "types",
      full_schema_scan: false,
      matched_entity_type_ids: [...entityIds],
      matched_concept_type_ids: [...conceptIds],
      matched_relation_type_ids: [...relationIds],
      included_entity_type_ids: includedEntityIds,
      included_concept_type_ids: includedConceptIds,
      included_relation_type_ids: includedRelationIds,
      complete_for_selection: complete,
    },
    items,
    payload_bytes: usedBytes,
    ...(complete ? {} : { reason: "Matched compact definitions exceed the batch response budget; fetch them with llm_wiki_get_domain_schema mode=types." }),
  }
}

export function matchDomainSchemaTypesForText(schema, text, maxMatches = 12) {
  if (!schema || typeof text !== "string" || !text.trim()) {
    return { entityTypeIds: [], conceptTypeIds: [], relationTypeIds: [], matchedTerms: [], matcher: "cached-multi-pattern" }
  }
  const haystack = text.normalize("NFKC").toLowerCase()
  const limit = Math.min(Math.max(Number(maxMatches) || 12, 1), 50)
  const matchIndex = domainSchemaMatchIndex(schema)
  const ranked = new Map()
  const scannedTerms = contextAwareSchemaTerms(haystack, scanSchemaTerms(matchIndex.automaton, haystack))
  for (const term of scannedTerms) {
    for (const entry of matchIndex.entries.get(term) ?? []) {
      const key = `${entry.kind}:${entry.typeId}`
      const current = ranked.get(key) ?? { id: entry.typeId, score: 0, identityScore: 0, propertyMatches: 0, matches: [] }
      current.score += entry.weight
      if (entry.identity) current.identityScore += entry.weight
      else current.propertyMatches += 1
      current.matches.push(entry.value)
      ranked.set(key, current)
    }
  }
  const resultFor = (kind, id) => {
    const result = ranked.get(`${kind}:${id}`) ?? { id, score: 0, identityScore: 0, propertyMatches: 0, matches: [] }
    return result.identityScore > 0 || result.propertyMatches >= 2
      ? { id, score: result.score, matches: result.matches }
      : { id, score: 0, matches: [] }
  }
  const entities = schema.entityTypes.map((type) => resultFor("entity", type.id))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit)
  const entityIds = new Set(entities.map((item) => item.id))
  const concepts = schema.conceptTypes.map((type) => resultFor("concept", type.id))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit)
  const relations = schema.relationTypes.map((type) => {
    const result = resultFor("relation", type.id)
    const connectsSelectedTypes = type.sourceEntityTypeIds.some((id) => entityIds.has(id))
      && type.targetEntityTypeIds.some((id) => entityIds.has(id))
    return { ...result, score: result.score + (connectsSelectedTypes ? 2 : 0) }
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit)
  return {
    entityTypeIds: entities.map((item) => item.id),
    conceptTypeIds: concepts.map((item) => item.id),
    relationTypeIds: relations.map((item) => item.id),
    matchedTerms: [...new Set([...entities, ...concepts, ...relations].flatMap((item) => item.matches))].slice(0, 50),
    matcher: "cached-multi-pattern",
  }
}

function domainSchemaMatchIndex(schema) {
  const cached = domainSchemaMatchIndexCache.get(schema)
  if (cached) return cached
  const entries = new Map()
  const add = (kind, typeId, value, weight, identity) => {
    const term = usefulSchemaMatchKey(value)
    if (!term) return
    const values = entries.get(term) ?? []
    values.push({ kind, typeId, value, weight, identity })
    entries.set(term, values)
  }
  for (const [kind, types] of [["entity", schema.entityTypes], ["concept", schema.conceptTypes], ["relation", schema.relationTypes]]) {
    for (const type of types) {
      add(kind, type.id, type.id, 60, true)
      add(kind, type.id, type.name, 50, true)
      type.aliases.forEach((alias) => add(kind, type.id, alias, 40, true))
      for (const property of type.properties) {
        add(kind, type.id, property.id, 8, false)
        add(kind, type.id, property.name, 6, false)
        property.aliases.forEach((alias) => add(kind, type.id, alias, 5, false))
      }
    }
  }
  const index = { entries, automaton: buildSchemaTermAutomaton(entries.keys()) }
  domainSchemaMatchIndexCache.set(schema, index)
  return index
}

function buildSchemaTermAutomaton(terms) {
  const nodes = [{ next: new Map(), fail: 0, outputs: [] }]
  for (const term of terms) {
    let state = 0
    for (const character of term) {
      let next = nodes[state].next.get(character)
      if (next === undefined) {
        next = nodes.length
        nodes[state].next.set(character, next)
        nodes.push({ next: new Map(), fail: 0, outputs: [] })
      }
      state = next
    }
    nodes[state].outputs.push(term)
  }
  const queue = []
  for (const next of nodes[0].next.values()) queue.push(next)
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor]
    for (const [character, next] of nodes[state].next) {
      queue.push(next)
      let fallback = nodes[state].fail
      while (fallback !== 0 && !nodes[fallback].next.has(character)) fallback = nodes[fallback].fail
      if (nodes[fallback].next.has(character)) fallback = nodes[fallback].next.get(character)
      nodes[next].fail = fallback
      nodes[next].outputs.push(...nodes[fallback].outputs)
    }
  }
  return nodes
}

function scanSchemaTerms(nodes, text) {
  const matched = new Set()
  let state = 0
  for (const character of text) {
    while (state !== 0 && !nodes[state].next.has(character)) state = nodes[state].fail
    if (nodes[state].next.has(character)) state = nodes[state].next.get(character)
    for (const term of nodes[state].outputs) matched.add(term)
  }
  return matched
}

function contextAwareSchemaTerms(text, terms) {
  const occurrences = []
  for (const term of terms) {
    for (const start of schemaTermStarts(text, term)) occurrences.push({ term, start, end: start + term.length })
  }
  const retained = occurrences.filter((occurrence) => !containsCjk(occurrence.term)
    || !occurrences.some((candidate) => candidate.term.length > occurrence.term.length
      && candidate.start < occurrence.end && candidate.end > occurrence.start))
  return new Set(retained.map((occurrence) => occurrence.term))
}

function schemaTermStarts(text, term) {
  const starts = []
  let cursor = text.indexOf(term)
  while (cursor >= 0) {
    const end = cursor + term.length
    if (containsCjk(term) || isWordBoundary(text, cursor, end)) starts.push(cursor)
    cursor = text.indexOf(term, cursor + Math.max(1, term.length))
  }
  return starts
}

function isWordBoundary(text, start, end) {
  const first = text[start]
  const last = text[end - 1]
  const previous = start > 0 ? text[start - 1] : ""
  const next = end < text.length ? text[end] : ""
  const word = (value) => Boolean(value) && /[\p{L}\p{N}_]/u.test(value)
  return !(word(first) && word(previous)) && !(word(last) && word(next))
}

function containsCjk(value) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
}

function hasSchemaTermMatch(text, term) {
  return schemaTermStarts(text, term).length > 0
}

export function paginateDomainSchema(schema, requestedCursor, requestedMaxChars, selection = {}) {
  if (isProgressiveSchema(schema)) {
    return progressiveSchemaDisclosure(schema, selection)
  }
  if (!schema) return { enabled: false, items: [], pagination: { cursor: 0, next_cursor: null, total_items: 0 } }
  const cursor = requestedCursor === undefined || requestedCursor === null ? 0 : Number(requestedCursor)
  if (!Number.isInteger(cursor) || cursor < 0) fail("INVALID_INPUT", "cursor must be a non-negative integer.")
  const maxChars = Math.min(Math.max(Number(requestedMaxChars) || 40_000, 20_000), 100_000)
  const selected = selectDomainSchemaItems(schema, selection)
  const items = selected.items
  if (cursor > items.length) fail("INVALID_INPUT", "cursor is beyond the domain Schema.")
  const page = []
  let usedBytes = 0
  let usedChars = 0
  let index = cursor
  while (index < items.length) {
    const serialized = JSON.stringify(items[index])
    const itemBytes = Buffer.byteLength(serialized)
    if (index > cursor && usedBytes + itemBytes > maxChars) break
    page.push(items[index])
    usedBytes += itemBytes
    usedChars += serialized.length
    index += 1
  }
  return {
    enabled: true,
    schema_id: schema.schemaId,
    schema_version: schema.schemaVersion,
    selection: selected.metadata,
    items: page,
    pagination: {
      cursor,
      next_cursor: index < items.length ? index : null,
      total_items: items.length,
      returned_items: page.length,
      approximate_chars: usedChars,
      approximate_bytes: usedBytes,
      truncated: index < items.length,
    },
  }
}

export function validateDomainSchema(input) {
  const errors = []
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_DOMAIN_SCHEMA", "Domain schema must be an object.")
  for (const key of ["formatVersion", "schemaId", "schemaVersion", "name", "language"]) {
    if (typeof input[key] !== "string" || !input[key].trim()) errors.push(`${key} must be a non-empty string`)
  }
  for (const key of ["formatVersion", "schemaId", "schemaVersion", "language"]) {
    if (typeof input[key] === "string" && input[key].length > 200) errors.push(`${key} exceeds 200 characters`)
  }
  if (typeof input.name === "string" && input.name.length > 500) errors.push("name exceeds 500 characters")
  if (typeof input.description === "string" && input.description.length > 10_000) errors.push("description exceeds 10000 characters")
  if (input.formatVersion !== "1.0") errors.push("formatVersion must be 1.0")
  if (input.policy !== undefined && (!input.policy || typeof input.policy !== "object" || Array.isArray(input.policy))) errors.push("policy must be an object")
  const policy = {
    extractionMode: input.policy?.extractionMode ?? "strict",
    validationFailurePolicy: input.policy?.validationFailurePolicy ?? "reject-batch",
    allowUnknownEntityTypes: input.policy?.allowUnknownEntityTypes ?? false,
    allowUnknownRelationTypes: input.policy?.allowUnknownRelationTypes ?? false,
    allowUnknownProperties: input.policy?.allowUnknownProperties ?? false,
  }
  if (!EXTRACTION_MODES.has(policy.extractionMode)) errors.push("policy.extractionMode must be strict or compatible")
  if (!FAILURE_POLICIES.has(policy.validationFailurePolicy)) errors.push("policy.validationFailurePolicy must be reject-batch or drop-invalid")
  for (const key of ["allowUnknownEntityTypes", "allowUnknownRelationTypes", "allowUnknownProperties"]) {
    if (typeof policy[key] !== "boolean") errors.push(`policy.${key} must be boolean`)
  }
  const entityTypes = normalizeTypes(input.entityTypes, "entityTypes", errors)
  validateLookupKeys(entityTypes, "entityTypes", errors)
  const entityIds = new Set(entityTypes.map((item) => item.id))
  const conceptTypes = input.conceptTypes === undefined
    ? []
    : normalizeTypes(input.conceptTypes, "conceptTypes", errors, true)
  validateLookupKeys(conceptTypes, "conceptTypes", errors)
  const relationTypes = normalizeTypes(input.relationTypes, "relationTypes", errors, true)
  validateLookupKeys(relationTypes, "relationTypes", errors)
  for (const [index, relation] of relationTypes.entries()) {
    for (const field of ["sourceEntityTypeIds", "targetEntityTypeIds"]) {
      if (!Array.isArray(relation[field]) || relation[field].length === 0) errors.push(`relationTypes[${index}].${field} must be a non-empty array`)
      else for (const id of relation[field]) if (!entityIds.has(id)) errors.push(`relationTypes[${index}].${field} references unknown entity type ${id}`)
    }
  }
  if (errors.length > 0) fail("INVALID_DOMAIN_SCHEMA", "Domain schema validation failed.", { details: { validation_errors: errors.slice(0, 100), validation_error_count: errors.length } })
  return {
    formatVersion: input.formatVersion,
    schemaId: input.schemaId,
    schemaVersion: input.schemaVersion,
    name: input.name,
    description: typeof input.description === "string" ? input.description : "",
    language: input.language,
    policy,
    entityTypes,
    conceptTypes,
    relationTypes,
  }
}

export function applyDomainSchema(analysis, schema) {
  if (!schema) return { analysis, report: null }
  if (isProgressiveSchema(schema)) return applyProgressiveSchema(analysis, schema)
  const mode = schema.policy.extractionMode
  const runtime = domainSchemaRuntime(schema)
  const entityLookup = runtime.entityLookup
  const conceptLookup = runtime.conceptLookup
  const relationLookup = runtime.relationLookup
  const violations = []
  const entityTypesByLocalId = new Map()
  const uniqueValues = new Map()
  const entities = []
  const entityLocalIds = new Set()
  let droppedEntities = 0
  for (const [index, original] of analysis.entities.entries()) {
    const result = normalizeEntity(original, index, schema, entityLookup, uniqueValues)
    if (result.value?.localId && entityLocalIds.has(result.value.localId)) result.errors.push(`entities[${index}].localId duplicates ${result.value.localId}`)
    if (result.errors.length > 0) {
      violations.push(...result.errors)
      droppedEntities += 1
      continue
    }
    entities.push(result.value)
    for (const key of result.uniqueKeys) uniqueValues.set(key, true)
    entityLocalIds.add(result.value.localId)
    entityTypesByLocalId.set(result.value.localId ?? result.value.local_id, result.value.entityTypeId)
  }
  const concepts = analysis.concepts.map((concept) => normalizeConcept(concept, conceptLookup, schema.policy.extractionMode))
  const relations = []
  const relationLocalIds = new Set()
  const relationUniqueValues = new Map()
  let droppedRelations = 0
  const relationConstraintsApplied = schema.relationTypes.length > 0
  if (!relationConstraintsApplied) {
    relations.push(...analysis.relations)
  } else {
    for (const [index, original] of analysis.relations.entries()) {
      const result = normalizeRelation(original, index, schema, relationLookup, entityTypesByLocalId, relationUniqueValues)
      if (result.value?.localId && relationLocalIds.has(result.value.localId)) result.errors.push(`relations[${index}].localId duplicates ${result.value.localId}`)
      if (result.errors.length > 0) {
        violations.push(...result.errors)
        droppedRelations += 1
        continue
      }
      relations.push(result.value)
      for (const key of result.uniqueKeys) relationUniqueValues.set(key, true)
      relationLocalIds.add(result.value.localId)
    }
  }
  const validationErrorCount = violations.length
  const report = {
    schema_id: schema.schemaId,
    schema_version: schema.schemaVersion,
    policy: schema.policy.validationFailurePolicy,
    violations: violations.slice(0, 100),
    validation_errors: violations.slice(0, 100),
    validation_error_count: validationErrorCount,
    validation_errors_truncated: validationErrorCount > 100,
    dropped_entities: droppedEntities,
    dropped_relations: droppedRelations,
    relation_constraints_applied: relationConstraintsApplied,
  }
  if (violations.length > 0 && schema.policy.validationFailurePolicy === "reject-batch") {
    fail("INVALID_DOMAIN_ANALYSIS", "Analysis does not conform to the task domain schema.", { details: report })
  }
  return { analysis: { ...analysis, entities, concepts, relations }, report }
}

function domainSchemaRecord(input) {
  let bytes
  try {
    bytes = Buffer.byteLength(JSON.stringify(input))
  } catch {
    fail("INVALID_DOMAIN_SCHEMA", "The domain schema must be JSON-serializable.")
  }
  if (bytes > MAX_DOMAIN_SCHEMA_BYTES) fail("INVALID_DOMAIN_SCHEMA", `The domain schema exceeds ${MAX_DOMAIN_SCHEMA_BYTES} bytes.`)
  const schema = validateDomainSchema(input)
  if (Buffer.byteLength(JSON.stringify(schema)) > MAX_DOMAIN_SCHEMA_BYTES) {
    fail("INVALID_DOMAIN_SCHEMA", `The normalized domain schema exceeds ${MAX_DOMAIN_SCHEMA_BYTES} bytes.`)
  }
  const normalizedBytes = Buffer.byteLength(JSON.stringify(schema))
  return {
    schema,
    metadata: {
      schema_id: schema.schemaId,
      schema_version: schema.schemaVersion,
      hash: sha256(stableStringify(schema)),
      size_bytes: normalizedBytes,
    },
  }
}

function normalizeTypes(value, field, errors, relation = false) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array${relation ? "" : " with at least one item"}`)
    return []
  }
  if (!relation && value.length === 0) {
    errors.push(`${field} must contain at least one item`)
    return []
  }
  if (value.length > 2_000) errors.push(`${field} exceeds 2000 items`)
  const ids = new Set()
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${field}[${index}] must be an object`)
      return { id: `invalid-${index}`, name: "", aliases: [], properties: [] }
    }
    const id = typeof item.id === "string" ? item.id.trim() : ""
    if (!id) errors.push(`${field}[${index}].id must be a non-empty string`)
    if (id.length > 200) errors.push(`${field}[${index}].id exceeds 200 characters`)
    if (ids.has(id)) errors.push(`${field}[${index}].id duplicates ${id}`)
    ids.add(id)
    if (typeof item.name !== "string" || !item.name.trim()) errors.push(`${field}[${index}].name must be a non-empty string`)
    if (typeof item.name === "string" && item.name.length > 500) errors.push(`${field}[${index}].name exceeds 500 characters`)
    if (typeof item.description === "string" && item.description.length > 10_000) errors.push(`${field}[${index}].description exceeds 10000 characters`)
    const aliases = Array.isArray(item.aliases) && item.aliases.every((alias) => typeof alias === "string") ? item.aliases : []
    if (item.aliases !== undefined && (!Array.isArray(item.aliases) || aliases.length !== item.aliases.length)) errors.push(`${field}[${index}].aliases must contain strings`)
    if (aliases.length > 100 || aliases.some((alias) => alias.length > 500)) errors.push(`${field}[${index}].aliases exceed the count or length limit`)
    const properties = normalizeProperties(item.properties, `${field}[${index}].properties`, errors)
    const normalized = {
      id,
      name: item.name ?? "",
      description: typeof item.description === "string" ? item.description : "",
      aliases,
      properties,
      ...(relation ? {
        sourceEntityTypeIds: normalizeEndpointIds(item.sourceEntityTypeIds, `${field}[${index}].sourceEntityTypeIds`, errors),
        targetEntityTypeIds: normalizeEndpointIds(item.targetEntityTypeIds, `${field}[${index}].targetEntityTypeIds`, errors),
      } : {}),
    }
    const { properties: _properties, ...pageDefinition } = normalized
    if (Buffer.byteLength(JSON.stringify(pageDefinition)) > MAX_DOMAIN_SCHEMA_ITEM_BYTES) {
      errors.push(`${field}[${index}] exceeds the bounded page-item size`)
    }
    return normalized
  })
}

function normalizeProperties(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`)
    return []
  }
  if (value.length > 1_000) errors.push(`${field} exceeds 1000 items`)
  const ids = new Set()
  return value.map((item, index) => {
    const id = typeof item?.id === "string" ? item.id.trim() : ""
    if (!id) errors.push(`${field}[${index}].id must be a non-empty string`)
    if (id.length > 200) errors.push(`${field}[${index}].id exceeds 200 characters`)
    if (ids.has(id)) errors.push(`${field}[${index}].id duplicates ${id}`)
    ids.add(id)
    if (typeof item?.name !== "string" || !item.name.trim()) errors.push(`${field}[${index}].name must be a non-empty string`)
    if (typeof item?.name === "string" && item.name.length > 500) errors.push(`${field}[${index}].name exceeds 500 characters`)
    if (typeof item?.description === "string" && item.description.length > 10_000) errors.push(`${field}[${index}].description exceeds 10000 characters`)
    if (!VALUE_TYPES.has(item?.valueType)) errors.push(`${field}[${index}].valueType is unsupported`)
    for (const flag of ["required", "unique"]) if (item?.[flag] !== undefined && typeof item[flag] !== "boolean") errors.push(`${field}[${index}].${flag} must be boolean`)
    const aliases = Array.isArray(item?.aliases) && item.aliases.every((alias) => typeof alias === "string") ? item.aliases : []
    if (item?.aliases !== undefined && (!Array.isArray(item.aliases) || aliases.length !== item.aliases.length)) errors.push(`${field}[${index}].aliases must contain strings`)
    if (aliases.length > 100 || aliases.some((alias) => alias.length > 500)) errors.push(`${field}[${index}].aliases exceed the count or length limit`)
    const normalized = {
      id,
      name: item?.name ?? "",
      description: typeof item?.description === "string" ? item.description : "",
      aliases,
      valueType: item?.valueType,
      required: item?.required === true,
      unique: item?.unique === true,
    }
    if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_DOMAIN_SCHEMA_ITEM_BYTES) {
      errors.push(`${field}[${index}] exceeds the bounded page-item size`)
    }
    return normalized
  })
}

function normalizeEndpointIds(value, field, errors) {
  if (!Array.isArray(value)) return value
  if (value.length > 2_000) errors.push(`${field} exceeds 2000 items`)
  if (value.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) {
    errors.push(`${field} must contain non-empty strings no longer than 200 characters`)
  }
  return value
}

function domainSchemaItems(schema, entityTypeIds, relationTypeIds, conceptTypeIds) {
  const items = [{
    kind: "schema",
    schema: {
      formatVersion: schema.formatVersion,
      schemaId: schema.schemaId,
      schemaVersion: schema.schemaVersion,
      name: schema.name,
      description: schema.description,
      language: schema.language,
      policy: schema.policy,
    },
  }]
  for (const entity of schema.entityTypes.filter((item) => !entityTypeIds || entityTypeIds.has(item.id))) {
    const { properties, ...definition } = entity
    items.push({ kind: "entity_type", entity_type: definition })
    for (const property of properties) items.push({ kind: "entity_property", entity_type_id: entity.id, property })
  }
  for (const concept of schema.conceptTypes.filter((item) => !conceptTypeIds || conceptTypeIds.has(item.id))) {
    const { properties, ...definition } = concept
    items.push({ kind: "concept_type", concept_type: definition })
    for (const property of properties) items.push({ kind: "concept_property", concept_type_id: concept.id, property })
  }
  for (const relation of schema.relationTypes.filter((item) => !relationTypeIds || relationTypeIds.has(item.id))) {
    const { properties, ...definition } = relation
    items.push({ kind: "relation_type", relation_type: definition })
    for (const property of properties) items.push({ kind: "relation_property", relation_type_id: relation.id, property })
  }
  return items
}

function selectDomainSchemaItems(schema, selection) {
  const mode = selection.mode ?? ((selection.queries?.length ?? 0) > 0 ? "search" : "page")
  if (!new Set(["page", "catalog", "search", "types"]).has(mode)) fail("INVALID_INPUT", "domain Schema mode must be page, catalog, search, or types.")
  if (mode === "page") {
    return { items: domainSchemaItems(schema), metadata: { mode: "page", full_schema_scan: true } }
  }
  if (mode === "catalog") {
    return {
      items: domainSchemaCatalogItems(schema),
      metadata: {
        mode: "catalog",
        full_schema_scan: false,
        entity_type_count: schema.entityTypes.length,
        concept_type_count: schema.conceptTypes.length,
        relation_type_count: schema.relationTypes.length,
      },
    }
  }

  const requestedEntityIds = new Set(normalizeSelectionStrings(selection.entityTypeIds, "entity_type_ids"))
  const requestedConceptIds = new Set(normalizeSelectionStrings(selection.conceptTypeIds, "concept_type_ids"))
  const requestedRelationIds = new Set(normalizeSelectionStrings(selection.relationTypeIds, "relation_type_ids"))
  const knownEntityIds = new Set(schema.entityTypes.map((item) => item.id))
  const knownConceptIds = new Set(schema.conceptTypes.map((item) => item.id))
  const knownRelationIds = new Set(schema.relationTypes.map((item) => item.id))
  const unknownEntityIds = [...requestedEntityIds].filter((id) => !knownEntityIds.has(id))
  const unknownConceptIds = [...requestedConceptIds].filter((id) => !knownConceptIds.has(id))
  const unknownRelationIds = [...requestedRelationIds].filter((id) => !knownRelationIds.has(id))
  const queries = normalizeSelectionStrings(selection.queries, "queries", 20, 2_000)
  const maximumMatches = Math.min(Math.max(Number(selection.maxMatches) || 12, 1), 50)
  if (mode === "search" && queries.length === 0) fail("INVALID_INPUT", "search mode requires at least one query.")
  if (mode === "types" && requestedEntityIds.size === 0 && requestedConceptIds.size === 0 && requestedRelationIds.size === 0) {
    fail("INVALID_INPUT", "types mode requires entity_type_ids, concept_type_ids, or relation_type_ids.")
  }

  if (mode === "search") {
    for (const match of rankedSchemaMatches(schema.entityTypes, queries, maximumMatches)) requestedEntityIds.add(match.id)
    for (const match of rankedSchemaMatches(schema.conceptTypes, queries, maximumMatches)) requestedConceptIds.add(match.id)
    for (const match of rankedSchemaMatches(schema.relationTypes, queries, maximumMatches)) requestedRelationIds.add(match.id)
  }
  // A selected relation is unusable without its endpoint entity definitions.
  for (const relation of schema.relationTypes) {
    if (!requestedRelationIds.has(relation.id)) continue
    relation.sourceEntityTypeIds.forEach((id) => requestedEntityIds.add(id))
    relation.targetEntityTypeIds.forEach((id) => requestedEntityIds.add(id))
  }

  const entityTypeIds = new Set([...requestedEntityIds].filter((id) => knownEntityIds.has(id)))
  const conceptTypeIds = new Set([...requestedConceptIds].filter((id) => knownConceptIds.has(id)))
  const relationTypeIds = new Set([...requestedRelationIds].filter((id) => knownRelationIds.has(id)))
  return {
    items: domainSchemaItems(schema, entityTypeIds, relationTypeIds, conceptTypeIds),
    metadata: {
      mode,
      full_schema_scan: false,
      queries,
      matched_entity_type_ids: [...entityTypeIds],
      matched_concept_type_ids: [...conceptTypeIds],
      matched_relation_type_ids: [...relationTypeIds],
      unknown_entity_type_ids: unknownEntityIds,
      unknown_concept_type_ids: unknownConceptIds,
      unknown_relation_type_ids: unknownRelationIds,
      complete_for_selection: true,
    },
  }
}

function domainSchemaCatalogItems(schema) {
  const items = [{
    kind: "schema_catalog",
    schema: {
      schemaId: schema.schemaId,
      schemaVersion: schema.schemaVersion,
      name: schema.name,
      language: schema.language,
      policy: schema.policy,
    },
  }]
  for (const entity of schema.entityTypes) {
    items.push({
      kind: "entity_type_summary",
      id: entity.id,
      name: entity.name,
      aliases: entity.aliases,
      description: entity.description.slice(0, 500),
      property_count: entity.properties.length,
      required_property_ids: entity.properties.filter((property) => property.required).map((property) => property.id),
    })
  }
  for (const concept of schema.conceptTypes) {
    items.push({
      kind: "concept_type_summary",
      id: concept.id,
      name: concept.name,
      aliases: concept.aliases,
      description: concept.description.slice(0, 500),
      property_count: concept.properties.length,
      required_property_ids: concept.properties.filter((property) => property.required).map((property) => property.id),
    })
  }
  for (const relation of schema.relationTypes) {
    items.push({
      kind: "relation_type_summary",
      id: relation.id,
      name: relation.name,
      aliases: relation.aliases,
      description: relation.description.slice(0, 500),
      source_entity_type_ids: relation.sourceEntityTypeIds,
      target_entity_type_ids: relation.targetEntityTypeIds,
      property_count: relation.properties.length,
    })
  }
  return items
}

function rankedSchemaMatches(types, queries, limit) {
  const terms = [...new Set(queries.flatMap((query) => [query, ...query.split(/[\s,;:/|()\[\]{}\-_]+/u)])
    .map((term) => term.normalize("NFKC").toLowerCase().trim()).filter((term) => term.length >= 2))]
  return types.map((type) => {
    const identity = [type.id, type.name, ...type.aliases].join(" ").normalize("NFKC").toLowerCase()
    const searchable = [
      identity,
      type.description,
      ...type.properties.flatMap((property) => [property.id, property.name, ...property.aliases, property.description]),
    ].join(" ").normalize("NFKC").toLowerCase()
    let score = 0
    for (const term of terms) {
      if (identity === term) score += 100
      else if (hasSchemaTermMatch(identity, term)) score += 20
      else if (hasSchemaTermMatch(searchable, term)) score += 3
    }
    return { id: type.id, score }
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit)
}

function normalizeSelectionStrings(values, field, maxItems = 100, maxLength = 200) {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > maxItems
    || values.some((value) => typeof value !== "string" || !value.trim() || value.length > maxLength)) {
    fail("INVALID_INPUT", `${field} must contain at most ${maxItems} non-empty strings no longer than ${maxLength} characters.`)
  }
  return [...new Set(values.map((value) => value.normalize("NFKC").trim()))]
}

function usefulSchemaMatchKey(value) {
  if (typeof value !== "string") return null
  const key = value.normalize("NFKC").toLowerCase().trim()
  if (!key) return null
  const containsCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(key)
  if (containsCjk ? key.length < 2 : key.length < 3) return null
  return key
}

function validateLookupKeys(types, field, errors) {
  const typeKeys = new Map()
  for (const [typeIndex, type] of types.entries()) {
    for (const rawKey of [type.id, type.name, ...type.aliases]) {
      if (typeof rawKey !== "string" || !rawKey.trim()) continue
      const key = rawKey.normalize("NFKC").toLowerCase()
      const owner = typeKeys.get(key)
      if (owner !== undefined && owner !== typeIndex) errors.push(`${field}[${typeIndex}] lookup key ${rawKey} is ambiguous`)
      else typeKeys.set(key, typeIndex)
    }
    const propertyKeys = new Map()
    for (const [propertyIndex, property] of type.properties.entries()) {
      for (const rawKey of [property.id, property.name, ...property.aliases]) {
        if (typeof rawKey !== "string" || !rawKey.trim()) continue
        const key = rawKey.normalize("NFKC").toLowerCase()
        const owner = propertyKeys.get(key)
        if (owner !== undefined && owner !== propertyIndex) errors.push(`${field}[${typeIndex}].properties[${propertyIndex}] lookup key ${rawKey} is ambiguous`)
        else propertyKeys.set(key, propertyIndex)
      }
    }
  }
}

function typeLookup(types, mode) {
  const lookup = new Map()
  for (const type of types) {
    lookup.set(type.id, type)
    if (mode === "compatible") for (const value of [type.id, type.name, ...type.aliases]) lookup.set(value.normalize("NFKC").toLowerCase(), type)
  }
  return lookup
}

function domainSchemaRuntime(schema) {
  const cached = domainSchemaRuntimeCache.get(schema)
  if (cached) return cached
  const runtime = {
    entityLookup: typeLookup(schema.entityTypes, schema.policy.extractionMode),
    conceptLookup: typeLookup(schema.conceptTypes, schema.policy.extractionMode),
    relationLookup: typeLookup(schema.relationTypes, schema.policy.extractionMode),
  }
  domainSchemaRuntimeCache.set(schema, runtime)
  return runtime
}

function normalizeConcept(original, lookup, mode) {
  if (!original || typeof original !== "object" || Array.isArray(original)) return original
  const rawType = original.conceptTypeId ?? (mode === "compatible" ? original.concept_type_id : undefined)
  if (typeof rawType !== "string" || !rawType.trim()) return original
  const type = resolveType(rawType, lookup, mode)
  const value = { ...original, conceptTypeId: type?.id ?? rawType }
  if (mode === "compatible") delete value.concept_type_id
  return value
}

function resolveType(value, lookup, mode) {
  if (typeof value !== "string") return undefined
  return lookup.get(value) ?? (mode === "compatible" ? lookup.get(value.normalize("NFKC").toLowerCase()) : undefined)
}

function normalizeEntity(original, index, schema, lookup, uniqueValues) {
  const errors = []
  if (!original || typeof original !== "object" || Array.isArray(original)) return { errors: [`entities[${index}] must be an object`] }
  const compatible = schema.policy.extractionMode === "compatible"
  const localId = original.localId ?? (compatible ? original.local_id : undefined)
  if (typeof localId !== "string" || !localId.trim()) errors.push(`entities[${index}].localId must be a non-empty string`)
  const rawType = original.entityTypeId ?? (schema.policy.extractionMode === "compatible" ? original.entity_type_id ?? original.entityType : undefined)
  const type = resolveType(rawType, lookup, schema.policy.extractionMode)
  if (typeof rawType !== "string" || !rawType.trim()) errors.push(`entities[${index}].entityTypeId must be a non-empty string`)
  else if (!type && !schema.policy.allowUnknownEntityTypes) errors.push(`entities[${index}].entityTypeId is unknown: ${rawType}`)
  const propertiesResult = normalizeCandidateProperties(original.properties, type, `entities[${index}].properties`, schema.policy, uniqueValues)
  errors.push(...propertiesResult.errors)
  const value = { ...original, localId, entityTypeId: type?.id ?? rawType, properties: propertiesResult.properties }
  if (compatible) {
    delete value.local_id
    delete value.entity_type_id
    delete value.entityType
  }
  return { value, errors, uniqueKeys: propertiesResult.uniqueKeys }
}

function normalizeRelation(original, index, schema, lookup, entityTypesByLocalId, uniqueValues) {
  const errors = []
  if (!original || typeof original !== "object" || Array.isArray(original)) return { errors: [`relations[${index}] must be an object`] }
  const compatible = schema.policy.extractionMode === "compatible"
  const localId = original.localId ?? (compatible ? original.local_id : undefined)
  if (typeof localId !== "string" || !localId.trim()) errors.push(`relations[${index}].localId must be a non-empty string`)
  const rawType = original.relationTypeId ?? (compatible ? original.relation_type_id ?? original.relationType : undefined)
  const type = resolveType(rawType, lookup, schema.policy.extractionMode)
  if (typeof rawType !== "string" || !rawType.trim()) errors.push(`relations[${index}].relationTypeId must be a non-empty string`)
  else if (!type && !schema.policy.allowUnknownRelationTypes) errors.push(`relations[${index}].relationTypeId is unknown: ${rawType}`)
  const sourceId = original.sourceEntityLocalId ?? (compatible ? original.source_entity_local_id ?? original.sourceLocalId : undefined)
  const targetId = original.targetEntityLocalId ?? (compatible ? original.target_entity_local_id ?? original.targetLocalId : undefined)
  const sourceType = entityTypesByLocalId.get(sourceId)
  const targetType = entityTypesByLocalId.get(targetId)
  if (!sourceType) errors.push(`relations[${index}].sourceEntityLocalId does not reference a retained entity: ${String(sourceId ?? "")}`)
  if (!targetType) errors.push(`relations[${index}].targetEntityLocalId does not reference a retained entity: ${String(targetId ?? "")}`)
  if (type && sourceType && !type.sourceEntityTypeIds.includes(sourceType)) errors.push(`relations[${index}] source entity type ${sourceType} is not allowed for ${type.id}`)
  if (type && targetType && !type.targetEntityTypeIds.includes(targetType)) errors.push(`relations[${index}] target entity type ${targetType} is not allowed for ${type.id}`)
  const propertiesResult = normalizeCandidateProperties(original.properties, type, `relations[${index}].properties`, schema.policy, uniqueValues)
  errors.push(...propertiesResult.errors)
  const value = { ...original, localId, relationTypeId: type?.id ?? rawType, sourceEntityLocalId: sourceId, targetEntityLocalId: targetId, properties: propertiesResult.properties }
  if (compatible) {
    for (const key of ["local_id", "relation_type_id", "relationType", "source_entity_local_id", "sourceLocalId", "target_entity_local_id", "targetLocalId"]) delete value[key]
  }
  return { value, errors, uniqueKeys: propertiesResult.uniqueKeys }
}

function normalizeCandidateProperties(value, type, field, policy, uniqueValues) {
  const errors = []
  const uniqueKeys = []
  if (!value || typeof value !== "object" || Array.isArray(value)) return { properties: {}, errors: [`${field} must be an object`], uniqueKeys }
  if (!type) return { properties: { ...value }, errors, uniqueKeys }
  const lookup = candidatePropertyLookup(type, policy.extractionMode)
  const properties = {}
  for (const [rawKey, propertyValue] of Object.entries(value)) {
    const property = lookup.get(rawKey) ?? (policy.extractionMode === "compatible" ? lookup.get(rawKey.normalize("NFKC").toLowerCase()) : undefined)
    if (!property) {
      if (!policy.allowUnknownProperties) errors.push(`${field}.${rawKey} is not defined by type ${type.id}`)
      else properties[rawKey] = propertyValue
      continue
    }
    if (property.id in properties) {
      errors.push(`${field}.${rawKey} duplicates property ${property.id}`)
      continue
    }
    if (!valueMatchesType(propertyValue, property.valueType)) errors.push(`${field}.${rawKey} must be ${property.valueType}`)
    else properties[property.id] = propertyValue
  }
  for (const property of type.properties) if (property.required && !(property.id in properties)) errors.push(`${field}.${property.id} is required`)
  for (const property of type.properties) {
    if (!property.unique || !(property.id in properties)) continue
    const key = `${type.id}:${property.id}:${stableStringify(properties[property.id])}`
    if (uniqueValues.has(key)) errors.push(`${field}.${property.id} duplicates a unique value`)
    else uniqueKeys.push(key)
  }
  return { properties, errors, uniqueKeys }
}

function candidatePropertyLookup(type, mode) {
  let byMode = propertyLookupCache.get(type)
  if (!byMode) {
    byMode = new Map()
    propertyLookupCache.set(type, byMode)
  }
  if (byMode.has(mode)) return byMode.get(mode)
  const lookup = new Map(type.properties.map((property) => [property.id, property]))
  if (mode === "compatible") {
    for (const property of type.properties) {
      for (const key of [property.id, property.name, ...property.aliases]) {
        lookup.set(key.normalize("NFKC").toLowerCase(), property)
      }
    }
  }
  byMode.set(mode, lookup)
  return lookup
}

function valueMatchesType(value, type) {
  if (type === "string" || type === "date" || type === "datetime") return typeof value === "string"
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  if (type === "integer") return Number.isInteger(value)
  if (type === "boolean") return typeof value === "boolean"
  if (type === "json") return value !== undefined
  return false
}
