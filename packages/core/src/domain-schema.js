import { lstat } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"
import { pathExists } from "./utils.js"
import {
  PROGRESSIVE_SCHEMA_MODE,
  applyProgressiveSchema,
  isProgressiveSchema,
  loadProgressiveSchemaSnapshot,
  progressiveSchemaDisclosure,
  progressiveSchemaMetadata,
  resolveProgressiveSchemaDirectory,
} from "./schema-bundle.js"

const DEFAULT_PROGRESSIVE_SCHEMA_DIRECTORY = "llm-wiki.domain-schema"
const REMOVED_FIXED_SCHEMA_ARGUMENTS = [
  "mode", "queries", "entity_type_ids", "concept_type_ids",
  "relation_type_ids", "max_matches", "cursor", "max_chars",
]

export async function resolveDomainSchema(workspace, options = {}) {
  options = options ?? {}
  if (options.domain_schema !== undefined || options.domainSchema !== undefined) {
    fail("INVALID_DOMAIN_SCHEMA", "Inline domain Schemas are not supported. Pass domain_schema_path pointing to a progressive-directory-v2 Schema directory.")
  }
  const configuredPath = options.domain_schema_path ?? options.domainSchemaPath
  const schemaPath = configuredPath
    ? path.resolve(workspace.paths.root, configuredPath)
    : path.join(workspace.paths.root, DEFAULT_PROGRESSIVE_SCHEMA_DIRECTORY)
  if (!configuredPath && !(await pathExists(schemaPath))) return null

  let info
  try {
    info = await lstat(schemaPath)
  } catch {
    fail("INVALID_DOMAIN_SCHEMA", "The configured progressive domain Schema directory is not readable.")
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("INVALID_DOMAIN_SCHEMA", "domain_schema_path must point to a regular progressive-directory-v2 Schema directory.")
  }
  const bundle = await resolveProgressiveSchemaDirectory(schemaPath)
  return { schema: bundle, metadata: progressiveSchemaMetadata(bundle), bundle }
}

export async function loadTaskDomainSchema(record) {
  if (!record.task.domainSchema) return null
  if (record.task.domainSchema.schema_mode !== PROGRESSIVE_SCHEMA_MODE
    && record.task.domainSchema.mode !== PROGRESSIVE_SCHEMA_MODE) {
    fail("UNSUPPORTED_DOMAIN_SCHEMA_VERSION", "This task does not use progressive-directory-v2. Create a new task with a progressive Domain Schema directory.")
  }
  return loadProgressiveSchemaSnapshot(record)
}

export function domainSchemaContext(schema) {
  if (!schema) return { value: null, disclosure: null }
  assertProgressiveSchema(schema)
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
    disclosure: {
      mode: "domain-abe-be",
      tool: "llm_wiki_get_domain_schema",
      firstLevel: "domains",
      fullFileExposure: true,
    },
  }
}

export function applyDomainSchema(analysis, schema) {
  if (!schema) return { analysis, report: null }
  assertProgressiveSchema(schema)
  return applyProgressiveSchema(analysis, schema)
}

export function discloseDomainSchema(schema, input = {}) {
  assertProgressiveSchema(schema)
  const removed = REMOVED_FIXED_SCHEMA_ARGUMENTS.filter((key) => input[key] !== undefined)
  if (removed.length > 0) {
    fail("INVALID_INPUT", `Fixed-object Domain Schema arguments were removed: ${removed.join(", ")}. Use level=domains, level=domain, or level=abe.`)
  }
  return progressiveSchemaDisclosure(schema, input)
}

function assertProgressiveSchema(schema) {
  if (!isProgressiveSchema(schema)) {
    fail("UNSUPPORTED_DOMAIN_SCHEMA_VERSION", "Only progressive-directory-v2 Domain Schemas are supported.")
  }
}
