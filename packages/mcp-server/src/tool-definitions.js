const taskId = { type: "string", description: "Task ID in the current workspace." }
const closedObject = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false })

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "llm_wiki_import_files",
    description: "Import Agent-visible supported documents, including XLSX workbooks, into the current workspace's managed source store, parse and batch them, and create a resumable task. Initializes the workspace automatically.",
    inputSchema: closedObject({
      files: {
        type: "array", minItems: 1, maxItems: 100,
        items: closedObject({ path: { type: "string" }, display_name: { type: "string" } }, ["path"]),
      },
      options: closedObject({
        target_language: { type: "string" },
        force_reanalyze: { type: "boolean" },
        max_batch_chars: { type: "number", minimum: 1000, maximum: 30000 },
        domain_schema_path: { type: "string", description: "Agent-visible path to a domain extraction Schema JSON file. The validated Schema is snapshotted into the task." },
        domain_schema: { type: "object", description: "Inline domain extraction Schema. Use this or domain_schema_path, not both." },
      }),
    }, ["files"]),
  },
  {
    name: "llm_wiki_get_batch",
    description: "Lease and return one complete, stable, payload-bounded batch to an extraction worker. Different worker_id values receive different available batches; expired leases are safely reclaimed.",
    inputSchema: closedObject({
      task_id: taskId,
      batch_id: { type: ["string", "null"] },
      worker_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      max_chars: { type: "number", minimum: 1000, maximum: 30000, description: "Legacy compatibility hint only. Batches are fixed and bounded at import, and are always returned complete." },
    }, ["task_id"]),
  },
  {
    name: "llm_wiki_get_domain_schema",
    description: "Return one bounded page of the task's validated domain Schema. For large Schemas, repeat with next_cursor until null before extracting entities and relations.",
    inputSchema: closedObject({
      task_id: taskId,
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
    description: "Normalize SourceRefs, enforce Schema-first extraction, and persist one worker's analysis. Invalid domain candidates are rejected before persistence even under drop-invalid unless accept_dropped_candidates is explicitly true.",
    inputSchema: closedObject({ task_id: taskId, batch_id: { type: "string" }, worker_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" }, analysis: { type: "object" }, accept_dropped_candidates: { type: "boolean", description: "Explicit opt-in to destructive drop-invalid behavior. Omit or false for Schema-first rejection and correction." }, idempotency_key: { type: "string", minLength: 8, maxLength: 200 } }, ["task_id", "batch_id", "analysis", "idempotency_key"]),
  },
  {
    name: "llm_wiki_get_page_plan_context",
    description: "Lease and return bounded page-planning context. With writer_id, supports one incremental Wiki writer while extraction continues and a final full reconciliation after all batches. Repeat with the returned projection_id and next_cursor.",
    inputSchema: closedObject({
      task_id: taskId,
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      projection_id: { type: "string", minLength: 1, maxLength: 100 },
      cursor: { type: ["integer", "null"], minimum: 0 },
      max_chars: { type: "integer", minimum: 20000, maximum: 200000 },
    }, ["task_id"]),
  },
  {
    name: "llm_wiki_commit_pages",
    description: "Atomically commit one leased Wiki projection. Incremental commits remain provisional; the final full reconciliation stabilizes them. An empty patches array is accepted only to acknowledge a leased projection with no page changes.",
    inputSchema: closedObject({
      task_id: taskId,
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      projection_id: { type: "string", minLength: 1, maxLength: 100 },
      projection_complete: { type: "boolean", description: "Set false when more bounded patch commits remain for this projection. Omit or true on the final commit, including an empty acknowledgement." },
      based_on_wiki_revision: { type: "string", pattern: "^[0-9a-f]{64}$" },
      patches: { type: "array", minItems: 0, maxItems: 50, items: { type: "object" } },
      idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
    }, ["task_id", "based_on_wiki_revision", "patches", "idempotency_key"]),
  },
  {
    name: "llm_wiki_finalize",
    description: "Idempotently generate Core-owned source/index/overview/log pages, update deterministic indexes, lint, and complete a task.",
    inputSchema: closedObject({ task_id: taskId }, ["task_id"]),
  },
  {
    name: "llm_wiki_status",
    description: "Return one current-workspace task's persisted status and next action for interruption recovery.",
    inputSchema: closedObject({ task_id: taskId }, ["task_id"]),
  },
  {
    name: "llm_wiki_list_tasks",
    description: "List persisted tasks from the current workspace only, optionally filtered by status.",
    inputSchema: closedObject({ status: { type: "array", items: { type: "string" } }, limit: { type: "number", minimum: 1, maximum: 100 } }),
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
])
