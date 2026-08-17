import { LlmWikiError, asLlmWikiError } from "@llm-wiki/core"
import { createHash } from "node:crypto"
import { TOOL_DEFINITIONS } from "./tool-definitions.js"

const MAX_MCP_INPUT_BYTES = 12 * 1024 * 1024
// Claude Code persists oversized MCP results to disk and feeds only a file
// reference back to the Agent. Keep the wire result below its documented hard
// per-tool annotation ceiling so large task state cannot trigger context
// compaction or a one-line reader failure.
const MAX_MCP_OUTPUT_BYTES = 450 * 1024
const STRUCTURED_CONTENT_DUPLICATION_LIMIT = 128 * 1024
const MAX_ERROR_MESSAGE_CHARS = 2_000
const MAX_MCP_IN_FLIGHT = 8
const MAX_TASK_IN_FLIGHT = 4
const BUSY_RETRY_AFTER_MS = 1_500
const MCP_SIGNAL = Symbol.for("llm-wiki.mcp.signal")
const SEMANTIC_ANALYSIS_CODES = new Set(["INVALID_ANALYSIS", "INVALID_DOMAIN_ANALYSIS", "INVALID_SOURCE_REF", "ANALYSIS_TOO_LARGE", "ANALYSIS_REPAIR_REQUIRED"])
const ATOMIC_PAGE_REJECTION_CODES = new Set([
  "INVALID_PAGE_PATCH",
  "INVALID_WIKI_UPDATE",
  "INVALID_PAGE_PATH",
  "INVALID_SOURCE_REF",
  "WIKI_PAGE_NOT_FOUND",
  "WIKI_SECTION_NOT_FOUND",
  "WIKI_SECTION_AMBIGUOUS",
  "PAGE_COMMIT_TOO_LARGE",
  "PAGE_PLAN_INCOMPLETE",
  "INCOMPLETE_PAGE_COVERAGE",
  "PAGE_DRAFT_SHARDS_INCOMPLETE",
  "PAGE_DRAFT_SHARD_NOT_READY",
  "PAGE_DRAFT_SECTION_NOT_FULLY_VISIBLE",
  "PAGE_DRAFT_SCHEMA_UPGRADE_REQUIRED",
  "STAGED_DRAFT_NOT_FOUND",
  "STAGED_DRAFT_EXISTS",
  "STAGED_DRAFT_HASH_MISMATCH",
  "PAGE_DRAFT_STAGING_UNAVAILABLE",
  "DRAFT_SHARD_CLAIM_FENCED",
  "DUPLICATE_PAGE_COVERAGE",
  "FILE_HASH_CONFLICT",
  "PROVISIONAL_PAGE_CONFLICT",
  "WIKI_PUBLICATION_BUSY",
  "WORKSPACE_LOCKED",
])

function emergencyMcpResult() {
  const data = {
    ok: false,
    accepted: false,
    rejected: true,
    error: {
      code: "MCP_INTERNAL_ERROR",
      message: "The tool error response could not be serialized safely.",
      retryable: true,
      suggested_action: "Retry the tool with a smaller payload; the MCP connection remains usable.",
    },
    next_action: { tool: "llm_wiki_list_tasks", arguments: {} },
    mcp_connection_usable: true,
  }
  const text = JSON.stringify(data)
  return {
    content: [{ type: "text", text }],
    structuredContent: data,
    _meta: { llmWikiStatus: "rejected" },
  }
}

function compactMcpError(code, message, originalOutputBytes = undefined) {
  return {
    ok: false,
    accepted: false,
    rejected: true,
    error: {
      code,
      message,
      retryable: true,
      ...(originalOutputBytes === undefined ? {} : { details: { truncated: true, original_output_bytes: originalOutputBytes } }),
      suggested_action: "Submit a smaller payload and retry; the MCP connection remains usable.",
    },
    next_action: { tool: "llm_wiki_list_tasks", arguments: {} },
    mcp_connection_usable: true,
  }
}

function serializeCompactMcpError(data) {
  const error = data?.error
  const code = typeof error?.code === "string" && error.code.length <= 120 ? error.code : "MCP_OUTPUT_TOO_LARGE"
  const message = error
    ? `${String(error.message ?? "Tool call failed.").slice(0, MAX_ERROR_MESSAGE_CHARS)} (Error details were truncated to keep the MCP connection usable.)`
    : `Tool output exceeds the ${MAX_MCP_OUTPUT_BYTES}-byte MCP limit. Use pagination or a smaller result limit.`
  const compact = compactMcpError(code, message, data?.__serializedOutputBytes)
  let text
  try {
    text = JSON.stringify(compact, null, 2)
  } catch {
    return emergencyMcpResult()
  }
  // This is a fixed internal object and should always fit. Keep a final hard
  // guard so a future constant change cannot reintroduce recursive fallback.
  if (Buffer.byteLength(text) > MAX_MCP_OUTPUT_BYTES) return emergencyMcpResult()
  return { content: [{ type: "text", text }], _meta: { llmWikiStatus: "rejected" } }
}

function serializeResult(data) {
  let text
  try {
    // Keep indentation so large string fields are not emitted as one opaque
    // line in host-persisted MCP result files. The byte budget below still
    // bounds the complete response.
    text = JSON.stringify(data, null, 2)
  } catch {
    const compact = compactMcpError("MCP_SERIALIZATION_FAILED", "Tool result could not be serialized as JSON.")
    try {
      const compactText = JSON.stringify(compact, null, 2)
      return { content: [{ type: "text", text: compactText }], _meta: { llmWikiStatus: "rejected" } }
    } catch {
      return emergencyMcpResult()
    }
  }
  const outputBytes = Buffer.byteLength(text)
  if (outputBytes > MAX_MCP_OUTPUT_BYTES) {
    // Never carry next_action or arbitrary error details into the fallback:
    // those fields are exactly where an oversized result commonly lives.
    return serializeCompactMcpError({ ...data, __serializedOutputBytes: outputBytes })
  }
  const result = { content: [{ type: "text", text }] }
  // Analysis repair diagnostics are intentionally structured even when their
  // pretty JSON exceeds the normal duplication threshold. They remain bounded
  // by MAX_MCP_OUTPUT_BYTES, while generic large tool results still use the
  // one-copy wire path.
  const structuredAnalysisDiagnostics = Array.isArray(data?.validation_errors)
    && data?.semantic_repair?.required === true
    && outputBytes <= MAX_MCP_OUTPUT_BYTES
  if (outputBytes <= STRUCTURED_CONTENT_DUPLICATION_LIMIT || structuredAnalysisDiagnostics) result.structuredContent = data
  if (data?.ok === false || data?.accepted === false) result._meta = { llmWikiStatus: "rejected" }
  return result
}

function errorResult(error, context = {}) {
  const normalized = asLlmWikiError(error)
  const semanticAnalysisFailure = context.tool === "llm_wiki_commit_analysis" && SEMANTIC_ANALYSIS_CODES.has(normalized.code)
  const repairRequired = normalized.details?.repair_required === true
  const analysisRetry = semanticAnalysisFailure && !repairRequired
  const atomicPageRejection = ["llm_wiki_commit_pages", "llm_wiki_update_pages", "llm_wiki_stage_page_drafts"].includes(context.tool)
    && ATOMIC_PAGE_REJECTION_CODES.has(normalized.code)
  const submittedItems = context.tool === "llm_wiki_update_pages" ? context.args?.updates : context.args?.patches
  const normalizedJson = normalized.toJSON()
  const errorData = {
    ...normalizedJson,
    ...(semanticAnalysisFailure && normalizedJson.details
      ? { details: compactAnalysisErrorDetails(normalizedJson.details) }
      : {}),
    retryable: normalized.retryable || analysisRetry,
  }
  const busy = normalized.code === "TASK_BUSY" || normalized.code === "MCP_BUSY"
  return {
    ok: false,
    accepted: false,
    rejected: true,
    error: errorData,
    ...(busy ? {
      retry_after_ms: BUSY_RETRY_AFTER_MS,
      retry_action: {
        tool: context.tool,
        reuse_original_arguments: true,
        request_fingerprint: createHash("sha256").update(JSON.stringify(context.args ?? {})).digest("hex"),
      },
    } : {}),
    ...(Array.isArray(normalized.details?.validation_errors)
      ? { validation_errors: normalized.details.validation_errors }
      : semanticAnalysisFailure ? { validation_errors: [normalized.message] } : {}),
    ...(Array.isArray(normalized.details?.validation_diagnostics)
      ? { validation_diagnostics: normalized.details.validation_diagnostics }
      : {}),
    ...(Array.isArray(normalized.details?.grounding_warnings)
      ? { grounding_warnings: normalized.details.grounding_warnings }
      : {}),
    ...(typeof normalized.details?.validation_fingerprint === "string"
      ? { validation_fingerprint: normalized.details.validation_fingerprint }
      : {}),
    ...(normalized.details?.repair_required === true ? { repair_required: true } : {}),
    ...(normalized.details?.completion_gate && typeof normalized.details.completion_gate === "object"
      ? { completion_gate: normalized.details.completion_gate }
      : {}),
    ...(semanticAnalysisFailure ? {
      semantic_repair: {
        required: true,
        strategy: repairRequired ? "stop-after-repair-budget" : "repair-same-batch-same-worker",
        task_id: context.args?.task_id,
        batch_id: context.args?.batch_id,
        worker_id: context.args?.worker_id,
        ...(normalized.details?.validation_fingerprint ? { validation_fingerprint: normalized.details.validation_fingerprint } : {}),
        ...(normalized.details?.validation_attempt ? { validation_attempt: normalized.details.validation_attempt } : {}),
        ...(normalized.details?.validation_max_attempts ? { max_attempts: normalized.details.validation_max_attempts } : {}),
        ...(repairRequired ? { coordinator_action: "do_not_launch_new_extractor" } : {}),
      },
    } : {}),
    ...(atomicPageRejection ? {
      atomic_commit_applied: false,
      page_commit_recovery: {
        changes_applied: false,
        retry_scope: pageCommitRetryScope(normalized.code),
        submitted_patch_count: Array.isArray(submittedItems) ? submittedItems.length : 0,
        submitted_patch_ids: Array.isArray(submittedItems)
          ? submittedItems.map((patch) => patch?.patchId ?? patch?.update_id).filter((value) => typeof value === "string").slice(0, 50)
          : [],
        ...(context.tool === "llm_wiki_commit_pages" ? { preserve_projection_complete: context.args?.projection_complete !== false } : {}),
        instruction: pageCommitRetryInstruction(normalized.code),
      },
    } : {}),
    next_action: recoveryAction(context.tool, context.args, normalized),
    mcp_connection_usable: true,
  }
}

function compactAnalysisErrorDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return details
  const compact = Object.fromEntries(Object.entries(details).filter(([key]) => ![
    "validation_errors",
    "validation_error_messages",
    "validation_diagnostics",
    "grounding_warnings",
  ].includes(key)))
  return Object.keys(compact).length > 0 ? compact : undefined
}

function pageCommitRetryScope(code) {
  if (["WIKI_PAGE_NOT_FOUND", "WIKI_SECTION_NOT_FOUND", "WIKI_SECTION_AMBIGUOUS", "INVALID_WIKI_UPDATE"].includes(code)) return "entire_rejected_update_set_after_reinspection"
  if (code === "PAGE_PLAN_INCOMPLETE") return "prepare_server_manifest_then_process_one_bounded_shard"
  if (code === "PAGE_DRAFT_SHARDS_INCOMPLETE") return "process_next_uncommitted_server_shard"
  if (code === "PAGE_DRAFT_SHARD_NOT_READY") return "retrieve_all_cursors_for_the_reported_server_shard"
  if (code === "PAGE_DRAFT_SECTION_NOT_FULLY_VISIBLE") return "redraft_entire_shard_using_only_new_or_fully_visible_sections"
  if (code === "PAGE_DRAFT_SCHEMA_UPGRADE_REQUIRED") return "refresh_manifest_and_redraft_retired_merge_payloads"
  if (code === "STAGED_DRAFT_NOT_FOUND") return "restage_the_reported_shard_then_retry_server_commit"
  if (code === "STAGED_DRAFT_EXISTS") return "do_not_resubmit_an_accepted_shard"
  if (code === "PAGE_DRAFT_STAGING_UNAVAILABLE") return "resume_the_active_manifest_projection_before_server_commit"
  if (code === "INCOMPLETE_PAGE_COVERAGE") return "entire_rejected_patch_set_plus_missing_coverage"
  if (code === "DUPLICATE_PAGE_COVERAGE") return "entire_rejected_patch_set_after_unique_coverage_reconciliation"
  if (code === "WIKI_PUBLICATION_BUSY") return "unchanged_patch_set_after_publication_owner_finishes_and_rebase"
  if (["FILE_HASH_CONFLICT", "PROVISIONAL_PAGE_CONFLICT"].includes(code)) return "entire_rejected_patch_set_after_rebase"
  return "entire_rejected_patch_set"
}

function pageCommitRetryInstruction(code) {
  if (["WIKI_PAGE_NOT_FOUND", "WIKI_SECTION_NOT_FOUND", "WIKI_SECTION_AMBIGUOUS", "INVALID_WIKI_UPDATE"].includes(code)) return "Inspect every target page again, correct the section operations, and resubmit the entire rejected update set with a new idempotency key."
  if (code === "PAGE_PLAN_INCOMPLETE") return "Return control to the coordinator. It requests view=manifest, launches a Drafter for one bounded shard, and starts the Writer only after a receipt exists."
  if (code === "PAGE_DRAFT_SHARDS_INCOMPLETE") return "Return the next shard to the coordinator, which launches its Drafter; accepted earlier shards are durable and must not be regenerated."
  if (code === "PAGE_DRAFT_SHARD_NOT_READY") return "The coordinator must relaunch the shard's Drafter to retrieve every cursor and stage a receipt before restarting the Writer."
  if (code === "PAGE_DRAFT_SECTION_NOT_FULLY_VISIBLE") return "Redraft the entire rejected shard. Upsert only new headings or headings listed in editable_section_headings; leave protected sections unchanged."
  if (code === "PAGE_DRAFT_SCHEMA_UPGRADE_REQUIRED") return "The retired staged merge payload was discarded safely. Refresh the manifest and redraft every returned shard with the current PagePatch schema."
  if (code === "STAGED_DRAFT_NOT_FOUND") return "Return control to the coordinator so it can relaunch the reported Drafter; retry the Writer only after a replacement receipt exists."
  if (code === "STAGED_DRAFT_EXISTS") return "Do not resubmit an accepted shard; continue with the next uncommitted manifest shard."
  if (code === "PAGE_DRAFT_STAGING_UNAVAILABLE") return "Return control to the coordinator so it can resume the active manifest and stage the shard before restarting the Writer."
  if (code === "DRAFT_SHARD_CLAIM_FENCED") return "Discard the stale Drafter result, refresh the active manifest, and relaunch only the newly claimed shard action."
  if (code === "INCOMPLETE_PAGE_COVERAGE") return "Add the reported missing coverage to the rejected set and resubmit it; no patch from the rejected call was stored."
  if (code === "DUPLICATE_PAGE_COVERAGE") return "Keep every requirement ID on one canonical path, repair all reported duplicate owners, and resubmit the whole rejected set."
  if (code === "WIKI_PUBLICATION_BUSY") return "Do not create another task or retry in a loop. Resume the owning task, then refresh this projection against the published Wiki before retrying."
  if (["FILE_HASH_CONFLICT", "PROVISIONAL_PAGE_CONFLICT"].includes(code)) return "Rebase the conflicting target, then resubmit the whole rejected atomic patch set; do not retry only one patch."
  return "Correct every reported invalid patch and resubmit the whole rejected atomic patch set with a new idempotency key; do not retry only the failing patch."
}

function recoveryAction(tool, args, error) {
  if (tool === "llm_wiki_finalize"
    && ["FINALIZE_CATCHUP_REQUIRED", "FINAL_PROJECTION_REQUIRED"].includes(error.code)
    && error.details?.next_action?.tool) {
    return error.details.next_action
  }
  if (error.code === "WIKI_PUBLICATION_BUSY" && typeof error.details?.owner_task_id === "string") {
    return { tool: "llm_wiki_status", arguments: { task_id: error.details.owner_task_id } }
  }
  if (error.code === "TASK_BUSY") {
    return { tool, reuse_original_arguments: true, retry_after_ms: BUSY_RETRY_AFTER_MS }
  }
  if (error.code === "MCP_BUSY") return { tool, reuse_original_arguments: true, retry_after_ms: BUSY_RETRY_AFTER_MS }
  if (tool === "llm_wiki_commit_analysis" && SEMANTIC_ANALYSIS_CODES.has(error.code)) {
    if (error.details?.repair_required === true) {
      return {
        tool: "llm_wiki_status",
        action_owner: "coordinator",
        arguments: { task_id: args?.task_id },
        reason: "analysis_repair_required",
      }
    }
    return {
      tool,
      action_owner: "same-worker",
      arguments: {
        task_id: args?.task_id,
        batch_id: args?.batch_id,
        worker_id: args?.worker_id,
        ...(typeof args?.lease_token === "string" ? { lease_token: args.lease_token } : {}),
      },
      reason: "repair_same_batch_without_restarting_extractor",
    }
  }
  if (tool === "llm_wiki_commit_analysis" && error.code === "BATCH_LEASE_REQUIRED") {
    return {
      tool: "llm_wiki_get_batch",
      arguments: { task_id: args?.task_id, batch_id: args?.batch_id, worker_id: args?.worker_id },
    }
  }
  if (tool === "llm_wiki_get_batch" && error.code === "MCP_OUTPUT_TOO_LARGE") {
    return { tool, arguments: { task_id: args?.task_id, batch_id: args?.batch_id } }
  }
  if (tool === "llm_wiki_update_pages" && ["FILE_HASH_CONFLICT", "PROVISIONAL_PAGE_CONFLICT", "INVALID_WIKI_UPDATE", "WIKI_PAGE_NOT_FOUND", "WIKI_SECTION_NOT_FOUND", "WIKI_SECTION_AMBIGUOUS"].includes(error.code)) {
    return {
      tool,
      arguments: {
        task_id: args?.task_id,
        action: "inspect",
        targets: Array.isArray(args?.updates)
          ? args.updates.map((update) => ({ path: update?.path })).filter((target) => typeof target.path === "string").slice(0, 20)
          : [],
      },
    }
  }
  if (tool === "llm_wiki_update_pages" && ["WIKI_UPDATE_PUBLISH_FAILED", "WORKSPACE_CHANGED_DURING_INDEXING"].includes(error.code)) {
    return { tool: "llm_wiki_finalize", arguments: { task_id: args?.task_id } }
  }
  if (tool === "llm_wiki_stage_page_drafts" && ["INVALID_PAGE_PATCH", "INVALID_PAGE_PATH", "INVALID_SOURCE_REF", "INCOMPLETE_PAGE_COVERAGE", "DUPLICATE_PAGE_COVERAGE", "PAGE_COMMIT_TOO_LARGE", "PAGE_DRAFT_SECTION_NOT_FULLY_VISIBLE"].includes(error.code)) {
    return {
      tool,
      action_owner: "drafter",
      delegate_to: "llm-wiki-page-drafter",
      arguments: {
        task_id: args?.task_id,
        writer_id: args?.writer_id,
        projection_id: args?.projection_id,
        shard_id: args?.shard_id,
        draft_claim_token: args?.draft_claim_token,
      },
      required_generated_arguments: ["patches", "idempotency_key"],
    }
  }
  if (tool === "llm_wiki_commit_pages" && error.code === "PAGE_PLAN_INCOMPLETE") {
    return {
      tool: "llm_wiki_get_page_plan_context",
      action_owner: "coordinator",
      delegate_to: "llm-wiki-page-drafter",
      arguments: {
        task_id: args?.task_id,
        writer_id: args?.writer_id,
        projection_id: args?.projection_id,
        view: "manifest",
        cursor: 0,
        max_chars: 40_000,
      },
    }
  }
  if (tool === "llm_wiki_commit_pages" && error.code === "PAGE_DRAFT_SCHEMA_UPGRADE_REQUIRED") {
    return {
      tool: "llm_wiki_get_page_plan_context",
      action_owner: "coordinator",
      delegate_to: "llm-wiki-page-drafter",
      arguments: {
        task_id: args?.task_id,
        writer_id: args?.writer_id,
        projection_id: args?.projection_id,
        view: "manifest",
        cursor: 0,
        max_chars: 40_000,
      },
    }
  }
  if (tool === "llm_wiki_commit_pages" && ["FILE_HASH_CONFLICT", "PROVISIONAL_PAGE_CONFLICT"].includes(error.code)) {
    return {
      tool: "llm_wiki_get_page_plan_context",
      action_owner: "coordinator",
      delegate_to: "llm-wiki-page-drafter",
      arguments: {
        task_id: args?.task_id,
        writer_id: args?.writer_id,
        projection_id: args?.projection_id,
        view: "manifest",
        cursor: 0,
        max_chars: 40_000,
      },
    }
  }
  if (tool === "llm_wiki_commit_pages" && ["INCOMPLETE_PAGE_COVERAGE", "PAGE_DRAFT_SHARDS_INCOMPLETE", "PAGE_DRAFT_SHARD_NOT_READY"].includes(error.code) && error.details?.next_draft_shard?.shard_id) {
    return {
      tool: "llm_wiki_get_page_plan_context",
      action_owner: "coordinator",
      arguments: {
        task_id: args?.task_id,
        writer_id: args?.writer_id,
        projection_id: args?.projection_id,
        view: "manifest",
        cursor: 0,
        max_chars: 40_000,
      },
    }
  }
  if (tool === "llm_wiki_commit_pages" && ["STAGED_DRAFT_NOT_FOUND", "PAGE_DRAFT_STAGING_UNAVAILABLE"].includes(error.code)) {
    return {
      tool: "llm_wiki_get_page_plan_context",
      action_owner: "coordinator",
      delegate_to: "llm-wiki-page-drafter",
      arguments: {
        task_id: args?.task_id,
        writer_id: args?.writer_id,
        projection_id: args?.projection_id,
        view: "manifest",
        cursor: 0,
        max_chars: 40_000,
      },
    }
  }
  if (tool === "llm_wiki_commit_pages" && ["INVALID_PAGE_PATCH", "INVALID_PAGE_PATH", "INVALID_SOURCE_REF", "INCOMPLETE_PAGE_COVERAGE", "DUPLICATE_PAGE_COVERAGE", "PAGE_COMMIT_TOO_LARGE"].includes(error.code)) {
    return {
      tool,
      action_owner: "writer",
      delegate_to: "llm-wiki-writer",
      arguments: {
        task_id: args?.task_id,
        writer_id: args?.writer_id,
        projection_id: args?.projection_id,
        based_on_wiki_revision: args?.based_on_wiki_revision,
        projection_complete: args?.projection_complete !== false,
        ...(Array.isArray(args?.staged_draft_receipts) ? { staged_draft_receipts: args.staged_draft_receipts } : {}),
      },
    }
  }
  if (tool === "llm_wiki_get_page_plan_context" && ["PAGE_PLAN_CURSOR_MISMATCH", "PAGE_PLAN_SNAPSHOT_MISSING", "PAGE_DRAFT_SHARD_NOT_FOUND"].includes(error.code)) {
    return {
      tool,
      action_owner: "coordinator",
      arguments: {
        task_id: args?.task_id,
        writer_id: args?.writer_id,
        projection_id: args?.projection_id,
        view: "manifest",
        cursor: 0,
        max_chars: 40_000,
      },
    }
  }
  if (["llm_wiki_get_page_plan_context", "llm_wiki_stage_page_drafts"].includes(tool) && error.code === "DRAFT_SHARD_CLAIM_FENCED") {
    return {
      tool: "llm_wiki_get_page_plan_context",
      action_owner: "coordinator",
      arguments: {
        task_id: args?.task_id,
        writer_id: args?.writer_id,
        projection_id: args?.projection_id,
        view: "manifest",
        cursor: 0,
        max_chars: 40_000,
      },
    }
  }
  if (typeof args?.task_id === "string" && tool !== "llm_wiki_status") {
    return { tool: "llm_wiki_status", arguments: { task_id: args.task_id } }
  }
  return { tool: "llm_wiki_list_tasks", arguments: {} }
}

function attachSignal(args, signal) {
  if (!signal || !args || typeof args !== "object") return args
  // Keep the signal out of JSON payloads and idempotency hashes. A frozen
  // client argument object is copied once rather than mutated in place.
  if (Object.isExtensible(args)) {
    try {
      Object.defineProperty(args, MCP_SIGNAL, { value: signal, enumerable: false, configurable: true })
      return args
    } catch {
      // Fall through to a shallow copy for exotic host objects.
    }
  }
  return { ...args, [MCP_SIGNAL]: signal }
}

export class HeadlessToolRouter {
  constructor(core) {
    this.core = core
    this.activeCalls = 0
    this.activeCallsByTask = new Map()
  }

  listTools() {
    return TOOL_DEFINITIONS
  }

  async call(name, args = {}, options = {}) {
    switch (name) {
      case "llm_wiki_import_files": return this.core.importFiles(args)
      case "llm_wiki_get_batch": return this.core.getBatch(args)
      case "llm_wiki_renew_lease": return this.core.renewLease(args)
      case "llm_wiki_get_domain_schema": return this.core.getDomainSchema(args)
      case "llm_wiki_retrieve_context": return this.core.retrieveContext(args)
      case "llm_wiki_query_domain_pages": return this.core.queryDomainPages(args)
      case "llm_wiki_commit_analysis": return this.core.commitAnalysis(args)
      case "llm_wiki_get_page_plan_context": return this.core.getPagePlanContext(args)
      case "llm_wiki_stage_page_drafts": return this.core.stagePageDrafts(args)
      case "llm_wiki_get_staged_page_drafts": return this.core.getStagedPageDrafts(args)
      case "llm_wiki_commit_pages": return this.core.commitPages(args)
      case "llm_wiki_update_pages": return this.core.updatePages(args)
      case "llm_wiki_finalize": return this.core.finalize(args)
      case "llm_wiki_status": return this.core.status(args)
      case "llm_wiki_list_tasks": return this.core.listTasks(args)
      case "llm_wiki_delete_knowledge_base": return this.core.deleteKnowledgeBase(args)
      case "llm_wiki_abort": return this.core.abort(args)
      case "llm_wiki_lint": return this.core.lint(args)
      default: throw new LlmWikiError("TOOL_NOT_FOUND", `Unknown llm_wiki tool: ${name}`)
    }
  }

  runtimeStats() {
    return {
      activeCalls: this.activeCalls,
      activeTasks: this.activeCallsByTask.size,
      maxInFlight: MAX_MCP_IN_FLIGHT,
      maxTaskInFlight: MAX_TASK_IN_FLIGHT,
    }
  }

  #reserve(name, args, signal) {
    if (signal?.aborted) {
      throw new LlmWikiError("MCP_REQUEST_CANCELLED", "The host cancelled this MCP request before execution.", {
        retryable: true,
        details: { tool: name },
      })
    }
    const taskId = typeof args?.task_id === "string" ? args.task_id : null
    const taskActive = taskId ? (this.activeCallsByTask.get(taskId) ?? 0) : 0
    if (this.activeCalls >= MAX_MCP_IN_FLIGHT) {
      throw new LlmWikiError("MCP_BUSY", "The MCP server is handling its maximum number of concurrent tool calls.", {
        retryable: true,
        details: { retry_after_ms: BUSY_RETRY_AFTER_MS, active_calls: this.activeCalls, max_in_flight: MAX_MCP_IN_FLIGHT },
        suggestedAction: "Retry the same tool after retry_after_ms; do not restart MCP.",
      })
    }
    if (taskId && taskActive >= MAX_TASK_IN_FLIGHT) {
      throw new LlmWikiError("TASK_BUSY", `Task ${taskId} already has the maximum number of in-flight tool calls.`, {
        retryable: true,
        taskId,
        details: { retry_after_ms: BUSY_RETRY_AFTER_MS, active_calls: taskActive, max_task_in_flight: MAX_TASK_IN_FLIGHT },
        suggestedAction: "Retry after retry_after_ms; persisted leases and idempotency keys remain valid.",
      })
    }
    this.activeCalls += 1
    if (taskId) this.activeCallsByTask.set(taskId, taskActive + 1)
    return () => {
      this.activeCalls = Math.max(0, this.activeCalls - 1)
      if (!taskId) return
      const remaining = Math.max(0, (this.activeCallsByTask.get(taskId) ?? 1) - 1)
      if (remaining === 0) this.activeCallsByTask.delete(taskId)
      else this.activeCallsByTask.set(taskId, remaining)
    }
  }

  async callMcp(name, args = {}, options = {}) {
    let release
    try {
      const inputBytes = Buffer.byteLength(JSON.stringify(args))
      if (inputBytes > MAX_MCP_INPUT_BYTES) {
        throw new LlmWikiError("MCP_INPUT_TOO_LARGE", `Tool input exceeds the ${MAX_MCP_INPUT_BYTES}-byte MCP limit. Submit smaller batches.`, { retryable: true })
      }
      release = this.#reserve(name, args, options.signal)
      return serializeResult(await this.call(name, attachSignal(args, options.signal), options))
    } catch (error) {
      try {
        return serializeResult(errorResult(error, { tool: name, args }))
      } catch {
        // No tool-level error, including a serialization failure while
        // reporting another error, is allowed to reject the MCP request and
        // destabilize the long-lived STDIO transport.
        return emergencyMcpResult()
      }
    } finally {
      release?.()
    }
  }
}
