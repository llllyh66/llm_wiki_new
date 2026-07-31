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
      }),
    }, ["files"]),
  },
  {
    name: "llm_wiki_get_batch",
    description: "Return a stable, bounded batch of untrusted source chunks for the host Agent to analyze. Reading does not complete the batch.",
    inputSchema: closedObject({ task_id: taskId, batch_id: { type: ["string", "null"] }, max_chars: { type: "number", minimum: 1000, maximum: 30000 } }, ["task_id"]),
  },
  {
    name: "llm_wiki_retrieve_context",
    description: "Retrieve relevant existing Wiki pages and committed task analysis with deterministic BM25. Unavailable vector/graph channels degrade without failing.",
    inputSchema: closedObject({
      task_id: taskId,
      batch_id: { type: "string" },
      queries: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
      channels: { type: "array", items: { enum: ["bm25", "vector", "graph"] } },
      limit: { type: "number", minimum: 1, maximum: 100 },
    }, ["task_id", "batch_id", "queries"]),
  },
  {
    name: "llm_wiki_commit_analysis",
    description: "Validate and persist the host Agent's structured analysis for one batch. The Core never generates this semantic analysis.",
    inputSchema: closedObject({ task_id: taskId, batch_id: { type: "string" }, analysis: { type: "object" }, idempotency_key: { type: "string", minLength: 8, maxLength: 200 } }, ["task_id", "batch_id", "analysis", "idempotency_key"]),
  },
  {
    name: "llm_wiki_get_page_plan_context",
    description: "Return a bounded page of normalized task analysis, existing page snapshots and hashes, conflicts, and the PagePatch schema. Repeat with next_cursor until null before planning pages.",
    inputSchema: closedObject({
      task_id: taskId,
      cursor: { type: ["integer", "null"], minimum: 0 },
      max_chars: { type: "integer", minimum: 20000, maximum: 200000 },
    }, ["task_id"]),
  },
  {
    name: "llm_wiki_commit_pages",
    description: "Validate SourceRefs, paths, size and optimistic hashes, then atomically commit host-Agent PagePatch objects through staging and a journaled transaction.",
    inputSchema: closedObject({
      task_id: taskId,
      based_on_wiki_revision: { type: "string", pattern: "^[0-9a-f]{64}$" },
      patches: { type: "array", minItems: 1, maxItems: 50, items: { type: "object" } },
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
