import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"
import { pathExists, readJson, sha256, stableStringify } from "./utils.js"

const MAX_DOMAIN_SCHEMA_BYTES = 1024 * 1024
const VALUE_TYPES = new Set(["string", "number", "integer", "boolean", "date", "datetime", "json"])
const EXTRACTION_MODES = new Set(["strict", "compatible"])
const FAILURE_POLICIES = new Set(["reject-batch", "drop-invalid"])

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
  if (!info.isFile() || info.isSymbolicLink()) fail("INVALID_DOMAIN_SCHEMA", "The domain schema must be a regular JSON file, not a symbolic link.")
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
  return readJson(record.paths.domainSchema)
}

export function validateDomainSchema(input) {
  const errors = []
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_DOMAIN_SCHEMA", "Domain schema must be an object.")
  for (const key of ["formatVersion", "schemaId", "schemaVersion", "name", "language"]) {
    if (typeof input[key] !== "string" || !input[key].trim()) errors.push(`${key} must be a non-empty string`)
  }
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
    relationTypes,
  }
}

export function applyDomainSchema(analysis, schema) {
  if (!schema) return { analysis, report: null }
  const mode = schema.policy.extractionMode
  const entityLookup = typeLookup(schema.entityTypes, mode)
  const relationLookup = typeLookup(schema.relationTypes, mode)
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
  const relations = []
  const relationLocalIds = new Set()
  const relationUniqueValues = new Map()
  let droppedRelations = 0
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
  }
  if (violations.length > 0 && schema.policy.validationFailurePolicy === "reject-batch") {
    fail("INVALID_DOMAIN_ANALYSIS", "Analysis does not conform to the task domain schema.", { details: report })
  }
  return { analysis: { ...analysis, entities, relations }, report }
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
  return { schema, metadata: { schema_id: schema.schemaId, schema_version: schema.schemaVersion, hash: sha256(stableStringify(schema)) } }
}

function normalizeTypes(value, field, errors, relation = false) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array`)
    return []
  }
  const ids = new Set()
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${field}[${index}] must be an object`)
      return { id: `invalid-${index}`, name: "", aliases: [], properties: [] }
    }
    const id = typeof item.id === "string" ? item.id.trim() : ""
    if (!id) errors.push(`${field}[${index}].id must be a non-empty string`)
    if (ids.has(id)) errors.push(`${field}[${index}].id duplicates ${id}`)
    ids.add(id)
    if (typeof item.name !== "string" || !item.name.trim()) errors.push(`${field}[${index}].name must be a non-empty string`)
    const aliases = Array.isArray(item.aliases) && item.aliases.every((alias) => typeof alias === "string") ? item.aliases : []
    if (item.aliases !== undefined && (!Array.isArray(item.aliases) || aliases.length !== item.aliases.length)) errors.push(`${field}[${index}].aliases must contain strings`)
    const properties = normalizeProperties(item.properties, `${field}[${index}].properties`, errors)
    return {
      id,
      name: item.name ?? "",
      description: typeof item.description === "string" ? item.description : "",
      aliases,
      properties,
      ...(relation ? {
        sourceEntityTypeIds: item.sourceEntityTypeIds,
        targetEntityTypeIds: item.targetEntityTypeIds,
      } : {}),
    }
  })
}

function normalizeProperties(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`)
    return []
  }
  const ids = new Set()
  return value.map((item, index) => {
    const id = typeof item?.id === "string" ? item.id.trim() : ""
    if (!id) errors.push(`${field}[${index}].id must be a non-empty string`)
    if (ids.has(id)) errors.push(`${field}[${index}].id duplicates ${id}`)
    ids.add(id)
    if (typeof item?.name !== "string" || !item.name.trim()) errors.push(`${field}[${index}].name must be a non-empty string`)
    if (!VALUE_TYPES.has(item?.valueType)) errors.push(`${field}[${index}].valueType is unsupported`)
    for (const flag of ["required", "unique"]) if (item?.[flag] !== undefined && typeof item[flag] !== "boolean") errors.push(`${field}[${index}].${flag} must be boolean`)
    const aliases = Array.isArray(item?.aliases) && item.aliases.every((alias) => typeof alias === "string") ? item.aliases : []
    if (item?.aliases !== undefined && (!Array.isArray(item.aliases) || aliases.length !== item.aliases.length)) errors.push(`${field}[${index}].aliases must contain strings`)
    return {
      id,
      name: item?.name ?? "",
      description: typeof item?.description === "string" ? item.description : "",
      aliases,
      valueType: item?.valueType,
      required: item?.required === true,
      unique: item?.unique === true,
    }
  })
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
  const lookup = new Map(type.properties.map((property) => [property.id, property]))
  if (policy.extractionMode === "compatible") for (const property of type.properties) for (const key of [property.id, property.name, ...property.aliases]) lookup.set(key.normalize("NFKC").toLowerCase(), property)
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

function valueMatchesType(value, type) {
  if (type === "string" || type === "date" || type === "datetime") return typeof value === "string"
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  if (type === "integer") return Number.isInteger(value)
  if (type === "boolean") return typeof value === "boolean"
  if (type === "json") return value !== undefined
  return false
}
