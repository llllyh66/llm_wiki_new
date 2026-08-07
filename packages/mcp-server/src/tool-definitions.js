const taskId = { type: "string", description: "Task ID in the current workspace." }
const closedObject = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false })

const toolDefinitions = [
  {
    name: "llm_wiki_import_files",
    description: "Import Agent-visible supported documents, including XLSX workbooks, into the current workspace's managed source store, parse and batch them, and create a resumable task. Initializes the workspace automatically. The result requires background-agent-first extraction even when batch_count=1; the main Agent should coordinate and not call get_batch directly unless a worker creation or transport failure is recorded.",
    inputSchema: closedObject({
      files: {
        type: "array", minItems: 1, maxItems: 100,
        items: closedObject({ path: { type: "string" }, display_name: { type: "string" } }, ["path"]),
      },
      options: closedObject({
        target_language: { type: "string" },
        force_reanalyze: { type: "boolean" },
        max_batch_chars: { type: "number", minimum: 1000, maximum: 24000 },
        domain_schema_path: { type: "string", description: "Agent-visible path to a domain extraction Schema JSON file. The validated Schema is snapshotted into the task." },
        domain_schema: { type: "object", description: "Inline domain extraction Schema. Use this or domain_schema_path, not both." },
      }),
    }, ["files"]),
  },
  {
    name: "llm_wiki_get_batch",
    description: "Lease and return one complete, stable, Agent-readable batch with a server-generated exact evidence catalog, automatic bounded domain-Schema type selection, and a retrieval-optional extraction policy. Candidates cite evidence indexes, avoiding quote transcription and source rereads. Hard transport ceilings repair legacy oversized batches in place.",
    inputSchema: closedObject({
      task_id: taskId,
      batch_id: { type: ["string", "null"] },
      worker_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      max_chars: { type: "integer", minimum: 1000, maximum: 24000, description: "Safe persisted repartition target for unfinished batches. It never truncates content; original batch IDs and active worker reservations are preserved for each first repaired part." },
    }, ["task_id"]),
  },
  {
    name: "llm_wiki_get_domain_schema",
    description: "Return a bounded catalog, server-side lexical selection, exact type selection, or legacy full page from the validated domain Schema. Prefer search mode for large Schemas, then request exact matched type IDs; Core validation still enforces the complete snapshot.",
    inputSchema: closedObject({
      task_id: taskId,
      mode: { enum: ["page", "catalog", "search", "types"], description: "Use search for batch terms, catalog only when search is insufficient, types for exact IDs, or page for backward-compatible full scanning." },
      queries: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 2000 } },
      entity_type_ids: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 200 } },
      concept_type_ids: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 200 } },
      relation_type_ids: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 200 } },
      max_matches: { type: "integer", minimum: 1, maximum: 50 },
      cursor: { type: ["integer", "null"], minimum: 0 },
      max_chars: { type: "integer", minimum: 20000, maximum: 100000, description: "Compatibility name for the approximate UTF-8 byte budget of one Schema page." },
    }, ["task_id"]),
  },
  {
    name: "llm_wiki_retrieve_context",
    description: "Recall source chunks, committed analysis, and Wiki sections with RRF. batch_id is optional for task-wide user questions and may be supplied to prioritize one worker batch. Defaults to BM25 plus Embedding while building, then adds Wiki recall after completion.",
    inputSchema: closedObject({
      task_id: taskId,
      batch_id: { type: "string" },
      queries: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 2000 } },
      channels: { type: "array", items: { enum: ["bm25", "embedding", "wiki", "vector", "graph"] }, description: "Use bm25, embedding, and wiki. vector and graph are backward-compatible aliases." },
      limit: { type: "number", minimum: 1, maximum: 100 },
      max_chars: { type: "number", minimum: 1000, maximum: 120000 },
    }, ["task_id", "queries"]),
  },
  {
    name: "llm_wiki_commit_analysis",
    description: "Resolve server-generated evidence indexes, safely canonicalize uniquely matched legacy quotes, enforce Schema-first extraction, and persist one worker's analysis. Invalid domain candidates are rejected before persistence even under drop-invalid unless accept_dropped_candidates is explicitly true.",
    inputSchema: closedObject({ task_id: taskId, batch_id: { type: "string" }, worker_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" }, analysis: { type: "object" }, accept_dropped_candidates: { type: "boolean", description: "Explicit opt-in to destructive drop-invalid behavior. Omit or false for Schema-first rejection and correction." }, idempotency_key: { type: "string", minLength: 8, maxLength: 200 } }, ["task_id", "batch_id", "analysis", "idempotency_key"]),
  },
  {
    name: "llm_wiki_get_page_plan_context",
    description: "Lease a stable semantic Wiki projection. Prefer view=manifest: it returns hard commit limits and small server-side draft shards without putting the full plan in model context. When parallel drafting is enabled, the coordinator launches one llm-wiki-page-drafter per disjoint shard (up to four); each drafter fetches its own bounded context and stages a temporary PagePatch receipt. The stable Writer is the sole committer and uses staged_draft_shard_ids with patches:[]; serial page drafting is fallback only. Legacy view=plan cursor traversal remains available for compatibility.",
    inputSchema: closedObject({
      task_id: taskId,
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      projection_id: { type: "string", minLength: 1, maxLength: 100 },
      view: { enum: ["plan", "manifest", "draft-shard"], description: "Use manifest first, then draft-shard with a returned shard_id. plan is the legacy whole-plan cursor protocol." },
      shard_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^draft-[0-9]{4,}$" },
      cursor: { type: ["integer", "null"], minimum: 0 },
      max_chars: { type: "integer", minimum: 20000, maximum: 200000 },
    }, ["task_id"]),
  },
  {
    name: "llm_wiki_apply_projection",
    description: "Compatibility entrypoint that acquires or resumes a projection and returns its compact server-side draft manifest. It never writes pages automatically.",
    inputSchema: closedObject({
      task_id: taskId,
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      projection_id: { type: "string", minLength: 1, maxLength: 100, description: "Resume an existing projection lease. Omit to acquire the next ready projection." },
      max_projections: { type: "integer", minimum: 1, maximum: 24, description: "Legacy coordinator hint retained for compatibility; the call returns one compact manifest and the coordinator follows its next_action." },
    }, ["task_id"]),
  },
  {
    name: "llm_wiki_stage_page_drafts",
    description: "Persist one fully retrieved, path-disjoint semantic PagePatch shard in task-scoped temporary staging without writing Wiki pages. Page drafters use this receipt-only handoff; the stable Writer later commits the staged shard server-side.",
    inputSchema: closedObject({
      task_id: taskId,
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      projection_id: { type: "string", minLength: 1, maxLength: 100 },
      shard_id: { type: "string", pattern: "^draft-[0-9]{4,}$" },
      patches: { type: "array", minItems: 1, maxItems: 6, items: { type: "object" } },
      idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
    }, ["task_id", "writer_id", "projection_id", "shard_id", "patches", "idempotency_key"]),
  },
  {
    name: "llm_wiki_get_staged_page_drafts",
    description: "Return metadata-only receipts for staged PagePatch shards. The stable Writer calls this with receipt IDs supplied by the coordinator; it never returns page bodies and the coordinator must not substitute itself as committer.",
    inputSchema: closedObject({
      task_id: taskId,
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      projection_id: { type: "string", minLength: 1, maxLength: 100 },
      shard_ids: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", pattern: "^draft-[0-9]{4,}$" } },
    }, ["task_id", "writer_id", "projection_id"]),
  },
  {
    name: "llm_wiki_commit_pages",
    description: "Atomically commit one bounded semantic Wiki wave. The stable Writer is the only Agent that calls this tool. Hard maximum: 50 patches and the returned page_commit_limits may recommend a smaller wave. Use staged_draft_shard_ids with patches:[] to commit drafter-created temporary shards server-side; actual PagePatch bodies are neither required nor returned to the coordinator. Partition paths before drafting, commit accepted waves with projection_complete=false, and never regenerate accepted waves. Finish with projection_complete=true after every manifest shard is covered.",
    inputSchema: closedObject({
      task_id: taskId,
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      projection_id: { type: "string", minLength: 1, maxLength: 100 },
      projection_complete: { type: "boolean", description: "Set false when more bounded patch commits remain for this projection. Omit or true on the final commit, including an empty acknowledgement." },
      draft_shard_ids: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", pattern: "^draft-[0-9]{4,}$" }, description: "For projection_complete=false manifest waves, copy the shard IDs from the returned commit action." },
      staged_draft_shard_ids: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", pattern: "^draft-[0-9]{4,}$" }, description: "Optional server-side temporary draft shards produced by llm_wiki_stage_page_drafts. Use this instead of page bodies; Core loads and validates the staged patches atomically." },
      based_on_wiki_revision: { type: "string", pattern: "^[0-9a-f]{64}$" },
      patches: { type: "array", minItems: 0, maxItems: 50, items: { type: "object" } },
      idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
    }, ["task_id", "based_on_wiki_revision", "patches", "idempotency_key"]),
  },
  {
    name: "llm_wiki_finalize",
    description: "Idempotently generate Core-owned source/index/overview/log pages, update deterministic indexes, lint, and complete a task. For a completed domain-Schema task, set refresh_page_metadata=true to backfill type frontmatter and Domain Classification sections without re-running extraction.",
    inputSchema: closedObject({ task_id: taskId, refresh_page_metadata: { type: "boolean", description: "Refresh existing Wiki pages from the persisted task Schema and page coverage metadata." } }, ["task_id"]),
  },
  {
    name: "llm_wiki_status",
    description: "Return one current-workspace task's persisted status, current parallel worker recommendation and batch quantum, next action, and resumable worker reservations. Leases do not indicate live SubAgent processes; after a worker invocation ends, the same worker_id resumes any remaining reservation immediately.",
    inputSchema: closedObject({ task_id: taskId }, ["task_id"]),
  },
  {
    name: "llm_wiki_list_tasks",
    description: "List persisted tasks from the current workspace only, optionally filtered by status.",
    inputSchema: closedObject({ status: { type: "array", items: { type: "string" } }, limit: { type: "number", minimum: 1, maximum: 100 } }),
  },
  {
    name: "llm_wiki_delete_knowledge_base",
    description: "Destructively clear the current Wiki knowledge base after an exact confirmation. scope=wiki removes generated pages and retrieval indexes while retaining imported sources and task history; scope=knowledge_base also removes managed sources, tasks, journals, and staging while preserving workspace configuration and schema.",
    inputSchema: closedObject({
      scope: { enum: ["wiki", "knowledge_base"], description: "wiki keeps sources and task history; knowledge_base clears all managed knowledge data." },
      confirmation: { type: "string", enum: ["DELETE KNOWLEDGE BASE"], description: "Required explicit confirmation for this destructive operation." },
    }, ["scope", "confirmation"]),
  },
  {
    name: "llm_wiki_abort",
    description: "Cancel an unfinished task and clean uncommitted staging without deleting already committed Wiki pages.",
    inputSchema: closedObject({ task_id: taskId, reason: { type: "string", maxLength: 2000 } }, ["task_id"]),
  },
  {
    name: "llm_wiki_lint",
    description: "Run deterministic structural lint for the current Wiki, a task, or selected Agent-writable Wiki paths. It does not generate semantic content.",
    inputSchema: closedObject({ task_id: taskId, paths: { type: "array", items: { type: "string" }, maxItems: 100 } }),
  },
]

const TOOL_RESULT_LIMITS = Object.freeze({
  llm_wiki_get_batch: 80_000,
  llm_wiki_get_domain_schema: 120_000,
  llm_wiki_retrieve_context: 120_000,
  llm_wiki_get_page_plan_context: 120_000,
  llm_wiki_status: 120_000,
  llm_wiki_list_tasks: 80_000,
})

export const TOOL_DEFINITIONS = Object.freeze(toolDefinitions.map((tool) => Object.freeze({
  ...tool,
  _meta: {
    ...(tool._meta ?? {}),
    "anthropic/alwaysLoad": true,
    "anthropic/maxResultSizeChars": TOOL_RESULT_LIMITS[tool.name] ?? 80_000,
  },
})))
