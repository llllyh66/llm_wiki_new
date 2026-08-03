import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { fail } from "./errors.js"
import { ensureDir, hashDirectory, newId, nowIso, pathExists, readJson, writeJsonAtomic, writeTextAtomic } from "./utils.js"

export const DEFAULT_LIMITS = Object.freeze({
  maxSourceBytes: 25 * 1024 * 1024,
  maxChunkChars: 8_000,
  maxBatchChars: 30_000,
  maxPageChars: 200_000,
  maxAnalysisBytes: 2 * 1024 * 1024,
  maxCommitChars: 2_000_000,
  maxPagePlanChars: 200_000,
  maxPatchesPerCommit: 50,
  maxQuoteChars: 1_000,
})

const DEFAULT_SCHEMA = `# llm_wiki Schema

Agent-authored pages are allowed under:

- \`wiki/sources/\`
- \`wiki/entities/\`
- \`wiki/concepts/\`
- \`wiki/topics/\`
- \`wiki/comparisons/\`
- \`wiki/queries/\`
- \`wiki/synthesis/\`
- \`wiki/findings/\`
- \`wiki/methodology/\`
- \`wiki/thesis/\`
- \`wiki/meetings/\`, \`wiki/decisions/\`, \`wiki/projects/\`
- \`wiki/stakeholders/\`, \`wiki/goals/\`, \`wiki/habits/\`, \`wiki/reflections/\`
- \`wiki/chapters/\`, \`wiki/characters/\`, \`wiki/themes/\`
- \`wiki/plot-threads/\`, \`wiki/journal/\`

Every authored page must include a clear H1 and standard frontmatter. The Core
normalizes these fields deterministically: \`type\`, \`title\`, \`created\`,
\`updated\`, \`tags\`, \`related\`, \`sources\`, \`covers\`, and \`summary\`.
Use \`covers\` to list every \`page_requirements.requirement_id\` materialized by
the canonical page. Important entities and concepts are page requirements even
when the Agent emitted only a small \`candidatePages\` list. Preserve useful
body wikilinks; Finalize makes valid Related links bidirectional.

Every important factual statement must be backed by a SourceRef submitted with
the page patch. \`wiki/index.md\`, \`wiki/overview.md\`, and \`wiki/log.md\` are
maintained by the headless Core.
`

export async function resolveWorkspaceRoot(input) {
  const requested = path.resolve(input || process.cwd())
  let info
  try {
    info = await lstat(requested)
  } catch {
    fail("WORKSPACE_NOT_FOUND", "The configured workspace does not exist.", {
      details: { workspace: requested },
    })
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("INVALID_WORKSPACE", "The configured workspace must be a real local directory.")
  }
  return realpath(requested)
}

export function workspacePaths(root) {
  const state = path.join(root, ".llm-wiki")
  return {
    root,
    wiki: path.join(root, "wiki"),
    state,
    workspace: path.join(state, "workspace.json"),
    config: path.join(state, "config.json"),
    sources: path.join(state, "sources"),
    sourceObjects: path.join(state, "sources", "objects"),
    sourceManifests: path.join(state, "sources", "manifests"),
    tasks: path.join(state, "tasks"),
    indexes: path.join(state, "indexes"),
    locks: path.join(state, "locks"),
    journal: path.join(state, "journal"),
    importStaging: path.join(state, "import-staging"),
    schema: path.join(root, "llm-wiki.schema.md"),
  }
}

export async function ensureWorkspace(root, options = {}) {
  const paths = workspacePaths(root)
  const initialized = !(await pathExists(paths.workspace))
  for (const directory of [
    paths.wiki,
    paths.state,
    paths.sourceObjects,
    paths.sourceManifests,
    paths.tasks,
    paths.indexes,
    paths.locks,
    paths.journal,
    paths.importStaging,
  ]) await ensureDir(directory)

  if (initialized) {
    const createdAt = nowIso()
    await writeJsonAtomic(paths.workspace, {
      schemaVersion: 1,
      workspaceId: newId("workspace"),
      createdAt,
      root: ".",
      wikiDir: "wiki",
      stateDir: ".llm-wiki",
      targetLanguage: options.targetLanguage || "zh-CN",
      schemaPath: "llm-wiki.schema.md",
      retrieval: { bm25: true, embedding: { provider: "none", maxDocuments: 1_000 }, wiki: true, vectorFallback: true, rrfK: 60, maxDocuments: 10_000 },
      limits: { ...DEFAULT_LIMITS },
    })
    await writeJsonAtomic(paths.config, {
      schemaVersion: 1,
      targetLanguage: options.targetLanguage || "zh-CN",
      retrieval: { bm25: true, embedding: { provider: "none", maxDocuments: 1_000 }, wiki: true, vectorFallback: true, rrfK: 60, maxDocuments: 10_000 },
      limits: { ...DEFAULT_LIMITS },
    })
    if (!(await pathExists(paths.schema))) await writeTextAtomic(paths.schema, DEFAULT_SCHEMA)
  }

  const workspace = await readJson(paths.workspace)
  const config = await readJson(paths.config, {})
  return {
    initialized,
    paths,
    config: {
      ...workspace,
      ...config,
      retrieval: {
        ...workspace.retrieval,
        ...(config.retrieval ?? {}),
        embedding: { provider: "none", maxDocuments: 1_000, ...(workspace.retrieval?.embedding ?? {}), ...(config.retrieval?.embedding ?? {}) },
      },
      limits: { ...DEFAULT_LIMITS, ...workspace.limits, ...(config.limits ?? {}) },
    },
    revision: await hashDirectory(paths.wiki),
  }
}
