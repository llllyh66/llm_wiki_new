import { analysisSchema } from "@llm-wiki/core"

const taskId = { type: "string", description: "Task ID in the current workspace." }
const closedObject = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false })

function namespaceSchema(schema, namespace) {
  const rewrite = (value) => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      key === "$ref" && typeof entry === "string" && entry.startsWith("#/$defs/")
        ? `#/$defs/${namespace}_${entry.slice("#/$defs/".length)}`
        : rewrite(entry),
    ]))
  }
  const rewritten = rewrite(schema)
  const definitions = Object.fromEntries(Object.entries(rewritten.$defs ?? {}).map(([key, value]) => [`${namespace}_${key}`, value]))
  const { $id: _id, $defs: _defs, ...shape } = rewritten
  return { shape, definitions }
}

const commitAnalysisContract = namespaceSchema(analysisSchema, "analysis")
commitAnalysisContract.shape.required = [...new Set([...commitAnalysisContract.shape.required, "sourceRefMode"])]
commitAnalysisContract.shape.properties.sourceRefs = {
  ...commitAnalysisContract.shape.properties.sourceRefs,
  description: "Copy the complete numeric evidence-index catalog from get_batch.analysis_scaffold unchanged.",
  items: { type: "integer", minimum: 0 },
}
commitAnalysisContract.definitions.analysis_sourceRefList = {
  ...commitAnalysisContract.definitions.analysis_sourceRefList,
  description: "One or more evidence_catalog.evidence_index integers from the current batch.",
  items: { type: "integer", minimum: 0 },
}
const commitAnalysisInputSchema = closedObject({
  task_id: taskId,
  batch_id: { type: "string" },
  worker_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
  lease_token: { type: "string", minLength: 1, maxLength: 200 },
  analysis: {
    ...commitAnalysisContract.shape,
    description: "Copy get_batch.analysis_scaffold first, then fill semantic arrays. Keep numeric confidence values, sourceRefMode, the numeric top-level evidence catalog, and candidate evidence_index sourceRefs.",
  },
  idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
}, ["task_id", "batch_id", "worker_id", "lease_token", "analysis", "idempotency_key"])
commitAnalysisInputSchema.$defs = commitAnalysisContract.definitions
const stagedDraftReceipt = closedObject({
  shard_id: { type: "string", pattern: "^draft-[0-9]{4,}$" },
  draft_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
}, ["shard_id", "draft_hash"])
const wikiSectionChange = closedObject({
  operation: { enum: ["upsert_section", "replace_section", "append_to_section", "remove_section"], description: "Apply one deterministic Markdown section edit. Core-owned Related and Domain Classification sections cannot be edited directly." },
  heading: { type: "string", minLength: 1, maxLength: 300, description: "Exact Markdown heading text without leading # characters." },
  level: { type: "integer", minimum: 2, maximum: 6, description: "Heading level for a newly inserted upsert_section; existing sections retain their current level." },
  content: { type: "string", description: "Section body without the heading. Required except for remove_section." },
}, ["operation", "heading"])
const incrementalWikiUpdate = closedObject({
  update_id: { type: "string", minLength: 1, maxLength: 200 },
  path: { type: "string", pattern: "^wiki/(sources|entities|concepts|topics|comparisons|queries|synthesis|findings|methodology|thesis|meetings|decisions|projects|stakeholders|goals|habits|reflections|chapters|characters|themes|plot-threads|journal)/.+\\.md$" },
  expected_file_hash: { type: "string", pattern: "^[0-9a-f]{64}$", description: "Exact file_hash returned by action=inspect." },
  changes: { type: "array", minItems: 1, maxItems: 20, items: wikiSectionChange },
  source_refs: { type: "array", maxItems: 500, items: { type: "object" }, description: "Exact SourceRefs from this task that ground every added, replaced, or appended section." },
  rationale: { type: "string", minLength: 1, maxLength: 2000 },
}, ["update_id", "path", "expected_file_hash", "changes", "rationale"])
const domainPageFilters = closedObject({
  domain_schema_id: { type: "string", minLength: 1, maxLength: 500, description: "Exact domain_schema_id stored in page frontmatter." },
  snapshot_hash: { type: "string", minLength: 1, maxLength: 500, description: "Exact progressive Domain Schema snapshot hash." },
  layout: { type: "string", minLength: 1, maxLength: 500, description: "Exact schema layout, normally progressive-directory-v2." },
  status: { enum: ["classified", "unresolved"] },
  kind: { enum: ["entity", "concept"] },
  domain: { type: "string", minLength: 1, maxLength: 500, description: "Exact Domain key or name, case-insensitive." },
  abe: { type: "string", minLength: 1, maxLength: 500, description: "Exact ABE key or name, case-insensitive." },
  be: { type: "string", minLength: 1, maxLength: 500, description: "Exact BE key or name, case-insensitive." },
  classification_path: { type: "string", minLength: 1, maxLength: 500, description: "Exact Domain/ABE/BE classification path." },
  classification_path_prefix: { type: "string", minLength: 1, maxLength: 500, description: "Domain or Domain/ABE path prefix; matches that node and every descendant." },
  page_kind: { type: "string", minLength: 1, maxLength: 100 },
})

const toolDefinitions = [
  {
    name: "llm_wiki_import_files",
    description: "Import Agent-visible supported documents, including PDF, PowerPoint, images with OCR, and XLSX workbooks, into the current workspace's managed source store, parse and batch them, and create or resume a build-equivalent task. Equivalent active source+Schema+language imports return reused_task=true instead of creating competing provisional publishers. Initializes the workspace automatically. The result requires background-agent-first extraction even when batch_count=1; the main Agent should coordinate and not call get_batch directly unless a worker creation or transport failure is recorded.",
    inputSchema: closedObject({
      files: {
        type: "array", minItems: 1, maxItems: 100,
        items: closedObject({ path: { type: "string" }, display_name: { type: "string" } }, ["path"]),
      },
      options: closedObject({
        target_language: { type: "string" },
        force_reanalyze: { type: "boolean", description: "Create a new equivalent task only after any matching task is terminal. Active equivalent tasks must be resumed and cannot be duplicated." },
        max_batch_chars: { type: "number", minimum: 1000, maximum: 24000 },
        progressive_import: { type: "boolean", description: "Return a durable task immediately, then parse and publish ready source chunks progressively. Use true for interactive imports." },
        domain_schema_path: { type: "string", description: "Agent-visible path to a progressive-directory-v2 Domain Schema directory. The validated directory is snapshotted into the task." },
        host_capabilities: closedObject({
          max_total_agents: { type: "integer", minimum: 1, maximum: 32 },
          coordinator_slots: { type: "integer", minimum: 1, maximum: 32 },
        }, ["max_total_agents", "coordinator_slots"]),
      }),
    }, ["files"]),
  },
  {
    name: "llm_wiki_get_batch",
    description: "Lease and return one complete, stable, Agent-readable batch with a server-generated exact evidence catalog, progressive Domain Schema disclosure metadata, and a retrieval-optional extraction policy. Candidates cite evidence indexes, avoiding quote transcription and source rereads. Hard transport ceilings repair oversized batches in place.",
    inputSchema: closedObject({
      task_id: taskId,
      batch_id: { type: ["string", "null"] },
      worker_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      max_chars: { type: "integer", minimum: 1000, maximum: 24000, description: "Safe persisted repartition target for unfinished batches. It never truncates content; original batch IDs and active worker reservations are preserved for each first repaired part." },
    }, ["task_id"]),
  },
  {
    name: "llm_wiki_get_domain_schema",
    description: "Progressively disclose a validated Schema directory. Call level=domains to read all_domains.json, level=domain to read the selected Domain's *_domain.json, and level=abe to read the complete selected ABE JSON plus a canonical classification_scaffold and bounded be_pointer_hints. JSON field names are unrestricted and the returned file is never truncated.",
    inputSchema: closedObject({
      task_id: taskId,
      level: { enum: ["domains", "domain", "abe"], description: "Disclosure level. domains reads all_domains.json; domain reads a Domain index; abe reads one complete ABE JSON." },
      domain_folder: { type: "string", minLength: 1, maxLength: 200, description: "One selected Domain folder name for level=domain or level=abe." },
      abe_file: { type: "string", minLength: 1, maxLength: 300, description: "One selected ABE JSON filename for level=abe. The full file is exposed." },
    }, ["task_id"]),
  },
  {
    name: "llm_wiki_renew_lease",
    description: "Renew one active extraction or projection lease. Extraction requires batch_id, worker_id, and lease_token; projection requires projection_id and writer_id. Total lease lifetime is bounded.",
    inputSchema: closedObject({
      task_id: taskId,
      batch_id: { type: "string", minLength: 1, maxLength: 100 },
      worker_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      lease_token: { type: "string", minLength: 1, maxLength: 200 },
      projection_id: { type: "string", minLength: 1, maxLength: 100 },
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
    }, ["task_id"]),
  },
  {
    name: "llm_wiki_retrieve_context",
    description: "Search the llm_wiki knowledge base for evidence needed to answer a user's question. Call this before answering factual questions about imported documents or generated Wiki content, even when an answer appears in prior conversation context. Returns relevant source chunks, committed analysis, and stable Wiki sections with identifiers and locators. Omit batch_id for normal task-wide questions; supply it only to prioritize one extractor batch. Results use BM25 plus Embedding while building and add Wiki title, path, and link-graph recall after completion.",
    inputSchema: closedObject({
      task_id: taskId,
      batch_id: { type: "string" },
      queries: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 2000 } },
      channels: { type: "array", items: { enum: ["bm25", "embedding", "wiki"] }, description: "Use exact channel names: bm25 and embedding while building; wiki becomes available from the published generation after completion." },
      limit: { type: "number", minimum: 1, maximum: 100 },
      max_chars: { type: "number", minimum: 1000, maximum: 120000 },
    }, ["task_id", "queries"]),
  },
  {
    name: "llm_wiki_query_domain_pages",
    description: "Inspect which Domain Schema and Domain/ABE/BE classifications belong to specific Wiki pages, or search all classified Wiki pages using exact schema, hierarchy, status, kind, and page-kind filters. Search returns bounded metadata and summaries with cursor pagination, never bulk page bodies.",
    inputSchema: closedObject({
      action: { enum: ["inspect", "search"] },
      paths: {
        type: "array", minItems: 1, maxItems: 20, uniqueItems: true,
        items: { type: "string", pattern: "^wiki/(sources|entities|concepts|topics|comparisons|queries|synthesis|findings|methodology|thesis|meetings|decisions|projects|stakeholders|goals|habits|reflections|chapters|characters|themes|plot-threads|journal)/.+\\.md$" },
        description: "Required for inspect. Returns Domain Schema metadata for these exact managed Wiki paths.",
      },
      filters: domainPageFilters,
      cursor: { type: "integer", minimum: 0, description: "Zero-based search result cursor returned by the previous call." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Search page size; defaults to 50." },
      max_chars: { type: "integer", minimum: 5000, maximum: 240000, description: "Approximate metadata character budget per search response; defaults to 80000 and may shorten a page before limit." },
    }, ["action"]),
  },
  {
    name: "llm_wiki_commit_analysis",
    description: "Submit an AnalysisEnvelope by copying get_batch.analysis_scaffold and filling its semantic arrays in the original language of their directly supporting source evidence; do not translate source-authored knowledge to target_language. The nested tool schema constrains required fields, numeric confidence values, evidence-index sourceRefs, and classification shape before the call. Core then resolves evidence, enforces progressive Schema classification, and persists the batch.",
    inputSchema: commitAnalysisInputSchema,
  },
  {
    name: "llm_wiki_get_page_plan_context",
    description: "Coordinator-owned projection tool. The coordinator calls view=manifest as soon as wiki_projection.ready=true even while Extractors remain, delegates bounded path-disjoint draft-shard actions within reported host capacity, preserves each page's source-evidence language, copies each TTL-bound draft_claim_token through every shard cursor, and starts the sole Writer only after hash-bound staged receipts exist. A waiting response includes an exact waiting_reason; never infer that all Extractors must finish. Claims and projection leases fence stale work but do not prove process liveness.",
    inputSchema: closedObject({
      task_id: taskId,
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      projection_id: { type: "string", minLength: 1, maxLength: 100 },
      view: { enum: ["manifest", "draft-shard"], description: "Use manifest first, then draft-shard with a returned shard_id." },
      shard_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^draft-[0-9]{4,}$" },
      draft_claim_token: { type: "string", minLength: 8, maxLength: 120, description: "Required for draft-shard view. Copy the current TTL-bound token from the exact manifest draft_action." },
      cursor: { type: ["integer", "null"], minimum: 0 },
      max_chars: { type: "integer", minimum: 20000, maximum: 200000 },
    }, ["task_id", "writer_id", "view"]),
  },
  {
    name: "llm_wiki_stage_page_drafts",
    description: "Persist one fully retrieved, path-disjoint semantic PagePatch shard in task-scoped temporary staging without writing Wiki pages. The Drafter must submit the exact current draft_claim_token; expired or superseded invocations are fenced. Success requires accepted=true, staged=true, a non-empty draft_hash, and a positive patch_count. Core persists the hash-bound receipt so status can recover a lost Drafter response; only then is the stable Writer launched to commit it server-side.",
    inputSchema: closedObject({
      task_id: taskId,
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      projection_id: { type: "string", minLength: 1, maxLength: 100 },
      shard_id: { type: "string", pattern: "^draft-[0-9]{4,}$" },
      draft_claim_token: { type: "string", minLength: 8, maxLength: 120, description: "Exact current token returned with the draft shard; stale tokens are fenced." },
      patches: { type: "array", minItems: 1, maxItems: 6, items: { type: "object" } },
      idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
    }, ["task_id", "writer_id", "projection_id", "shard_id", "draft_claim_token", "patches", "idempotency_key"]),
  },
  {
    name: "llm_wiki_get_staged_page_drafts",
    description: "Writer-owned metadata call. The stable Writer calls this only with completed, hash-bound staged receipts supplied by the coordinator. It never returns page bodies. Missing or changed receipts fail closed so the coordinator can relaunch the matching Drafter; the Writer must not discover or fetch shard context.",
    inputSchema: closedObject({
      task_id: taskId,
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      projection_id: { type: "string", minLength: 1, maxLength: 100 },
      draft_receipts: { type: "array", minItems: 1, maxItems: 8, items: stagedDraftReceipt },
    }, ["task_id", "writer_id", "projection_id", "draft_receipts"]),
  },
  {
    name: "llm_wiki_commit_pages",
    description: "Writer-owned atomic commit. In normal mode the stable Writer is launched only after Drafter receipts exist and commits hash-bound staged_draft_receipts with patches:[]; it never launches Drafters or fetches manifest/draft-shard context. Hard maximum: 50 patches. After one staged wave it returns any coordinator-owned next action instead of executing it. Direct PagePatch commits are reserved for the explicitly requested serial Writer fallback. Finish with projection_complete=true after every manifest shard is covered.",
    inputSchema: closedObject({
      task_id: taskId,
      writer_id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
      projection_id: { type: "string", minLength: 1, maxLength: 100 },
      projection_complete: { type: "boolean", description: "Set false when more bounded patch commits remain for this projection. Omit or true on the final commit, including an empty acknowledgement." },
      draft_shard_ids: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", pattern: "^draft-[0-9]{4,}$" }, description: "For projection_complete=false manifest waves, copy the shard IDs from the returned commit action." },
      staged_draft_receipts: { type: "array", minItems: 1, maxItems: 8, items: stagedDraftReceipt, description: "Hash-bound server-side draft receipts returned by llm_wiki_get_staged_page_drafts. Current staged commits use this instead of bare shard IDs." },
      based_on_wiki_revision: { type: "string", pattern: "^[0-9a-f]{64}$" },
      patches: { type: "array", minItems: 0, maxItems: 50, items: { type: "object" } },
      idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
    }, ["task_id", "based_on_wiki_revision", "patches", "idempotency_key"]),
  },
  {
    name: "llm_wiki_update_pages",
    description: "Inspect or atomically update selected sections of existing pages in a completed Wiki without reopening the semantic Writer projection. Call action=inspect first to obtain the current wiki_revision, exact file hashes, page content or one named section, and section manifest. Then call action=apply with optimistic hashes, grounded SourceRefs, bounded section operations, and an idempotency key. A successful apply rebuilds retrieval indexes and atomically publishes a new generation.",
    inputSchema: closedObject({
      task_id: taskId,
      action: { enum: ["inspect", "apply"] },
      targets: {
        type: "array", minItems: 1, maxItems: 20,
        items: closedObject({
          path: { type: "string", pattern: "^wiki/(sources|entities|concepts|topics|comparisons|queries|synthesis|findings|methodology|thesis|meetings|decisions|projects|stakeholders|goals|habits|reflections|chapters|characters|themes|plot-threads|journal)/.+\\.md$" },
          heading: { type: "string", minLength: 1, maxLength: 300, description: "Optional exact section heading. When supplied, inspect returns only that section body." },
        }, ["path"]),
      },
      max_chars: { type: "integer", minimum: 1000, maximum: 240000, description: "Maximum combined page or section content returned by inspect. Oversized content is omitted while hashes and section manifests remain available." },
      based_on_wiki_revision: { type: "string", pattern: "^[0-9a-f]{64}$", description: "Exact wiki_revision returned by inspect." },
      updates: { type: "array", minItems: 1, maxItems: 20, items: incrementalWikiUpdate },
      idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
    }, ["task_id", "action"]),
  },
  {
    name: "llm_wiki_finalize",
    description: "Finalize-first publication entry point. Call only when status.completion_gate.finalize_ready=true. FINALIZE_CATCHUP_REQUIRED means a bounded projection window finished while extracted or unprojected batches remain; execute its exact next_action automatically instead of asking the user whether to continue. After incremental catch-up, Core audits complete and unique requirement coverage, contradictions/review items, provisional page hashes, task commit ownership, and exact SourceRefs. Eligible pages are promoted without a second semantic rewrite; otherwise FINAL_PROJECTION_REQUIRED returns the exact semantic projection next action. Then idempotently generate Core-owned source/index/overview/log pages, update deterministic indexes, lint, and complete the task. For a completed domain-Schema task, set refresh_page_metadata=true to backfill type frontmatter and Domain Classification sections without re-running extraction.",
    inputSchema: closedObject({ task_id: taskId, refresh_page_metadata: { type: "boolean", description: "Refresh existing Wiki pages from the persisted task Schema and page coverage metadata." } }, ["task_id"]),
  },
  {
    name: "llm_wiki_status",
    description: "Return one current-workspace task's persisted status, completion_gate, current parallel worker recommendation and batch quantum, finalize-first audit state, next action, resumable worker reservations, recoverable staged draft receipts, and unified subagent_recovery demand for Extractor, Drafter, and Writer roles. A completed shard manifest or projection window is not task completion: while completion_gate.automatic_continuation_required=true, execute next_action and never ask the user whether to continue. Core cannot observe host process liveness: leases, in_progress, pending shards, and receipts never prove a SubAgent is live. The coordinator reconciles host-confirmed live sets before waiting and immediately fills every missing desired invocation.",
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
  llm_wiki_query_domain_pages: 240_000,
  llm_wiki_get_page_plan_context: 120_000,
  llm_wiki_update_pages: 240_000,
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
