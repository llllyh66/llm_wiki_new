import { LlmWikiError, asLlmWikiError } from "@llm-wiki/core"
import { TOOL_DEFINITIONS } from "./tool-definitions.js"

const MAX_MCP_INPUT_BYTES = 12 * 1024 * 1024
const MAX_MCP_OUTPUT_BYTES = 6 * 1024 * 1024
const STRUCTURED_CONTENT_DUPLICATION_LIMIT = 128 * 1024
const MAX_ERROR_MESSAGE_CHARS = 2_000
const RECOVERABLE_ANALYSIS_CODES = new Set(["INVALID_ANALYSIS", "INVALID_DOMAIN_ANALYSIS", "INVALID_SOURCE_REF", "ANALYSIS_TOO_LARGE"])
const ATOMIC_PAGE_REJECTION_CODES = new Set([
  "INVALID_PAGE_PATCH",
  "INVALID_PAGE_PATH",
  "INVALID_SOURCE_REF",
  "PAGE_COMMIT_TOO_LARGE",
  "PAGE_PLAN_INCOMPLETE",
  "INCOMPLETE_PAGE_COVERAGE",
  "PAGE_DRAFT_SHARDS_INCOMPLETE",
  "PAGE_DRAFT_SHARD_NOT_READY",
  "DUPLICATE_PAGE_COVERAGE",
  "FILE_HASH_CONFLICT",
  "PROVISIONAL_PAGE_CONFLICT",
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

function serializeResult(data) {
  let text
  try {
    text = JSON.stringify(data, null, 2)
  } catch {
    return serializeResult(errorResult(new LlmWikiError("MCP_SERIALIZATION_FAILED", "Tool result could not be serialized as JSON.")))
  }
  const outputBytes = Buffer.byteLength(text)
  if (outputBytes > MAX_MCP_OUTPUT_BYTES) {
    const original = data?.error
    return serializeResult({
      ok: false,
      accepted: false,
      rejected: true,
      error: {
        code: typeof original?.code === "string" ? original.code : "MCP_OUTPUT_TOO_LARGE",
        message: original
          ? `${String(original.message ?? "Tool call failed.").slice(0, MAX_ERROR_MESSAGE_CHARS)} (Error details were truncated to keep the MCP connection usable.)`
          : `Tool output exceeds the ${MAX_MCP_OUTPUT_BYTES}-byte MCP limit. Use pagination or a smaller result limit.`,
        retryable: true,
        ...(original?.task_id ? { task_id: original.task_id } : {}),
        details: { truncated: true, original_output_bytes: outputBytes },
        suggested_action: "Submit a smaller payload and retry; the MCP connection remains usable.",
      },
      next_action: data?.next_action ?? { tool: "llm_wiki_list_tasks", arguments: {} },
      mcp_connection_usable: true,
    })
  }
  const result = { content: [{ type: "text", text }] }
  if (outputBytes <= STRUCTURED_CONTENT_DUPLICATION_LIMIT) result.structuredContent = data
  if (data?.ok === false || data?.accepted === false) result._meta = { llmWikiStatus: "rejected" }
  return result
}

function errorResult(error, context = {}) {
  const normalized = asLlmWikiError(error)
  const analysisRetry = context.tool === "llm_wiki_commit_analysis" && RECOVERABLE_ANALYSIS_CODES.has(normalized.code)
  const atomicPageRejection = context.tool === "llm_wiki_commit_pages" && ATOMIC_PAGE_REJECTION_CODES.has(normalized.code)
  const errorData = { ...normalized.toJSON(), retryable: normalized.retryable || analysisRetry }
  return {
    ok: false,
    accepted: false,
    rejected: true,
    error: errorData,
    ...(Array.isArray(normalized.details?.validation_errors)
      ? { validation_errors: normalized.details.validation_errors }
      : analysisRetry ? { validation_errors: [normalized.message] } : {}),
    ...(atomicPageRejection ? {
      atomic_commit_applied: false,
      page_commit_recovery: {
        changes_applied: false,
        retry_scope: pageCommitRetryScope(normalized.code),
        submitted_patch_count: Array.isArray(context.args?.patches) ? context.args.patches.length : 0,
        submitted_patch_ids: Array.isArray(context.args?.patches)
          ? context.args.patches.map((patch) => patch?.patchId).filter((value) => typeof value === "string").slice(0, 50)
          : [],
        preserve_projection_complete: context.args?.projection_complete !== false,
        instruction: pageCommitRetryInstruction(normalized.code),
      },
    } : {}),
    next_action: recoveryAction(context.tool, context.args, normalized),
    mcp_connection_usable: true,
  }
}

function pageCommitRetryScope(code) {
  if (code === "PAGE_PLAN_INCOMPLETE") return "prepare_server_manifest_then_process_one_bounded_shard"
  if (code === "PAGE_DRAFT_SHARDS_INCOMPLETE") return "process_next_uncommitted_server_shard"
  if (code === "PAGE_DRAFT_SHARD_NOT_READY") return "retrieve_all_cursors_for_the_reported_server_shard"
  if (code === "INCOMPLETE_PAGE_COVERAGE") return "entire_rejected_patch_set_plus_missing_coverage"
  if (code === "DUPLICATE_PAGE_COVERAGE") return "entire_rejected_patch_set_after_unique_coverage_reconciliation"
  if (["FILE_HASH_CONFLICT", "PROVISIONAL_PAGE_CONFLICT"].includes(code)) return "entire_rejected_patch_set_after_rebase"
  return "entire_rejected_patch_set"
}

function pageCommitRetryInstruction(code) {
  if (code === "PAGE_PLAN_INCOMPLETE") return "Request view=manifest, then generate and commit one bounded draft shard at a time."
  if (code === "PAGE_DRAFT_SHARDS_INCOMPLETE") return "Process the returned next draft shard; accepted earlier shards are durable and must not be regenerated."
  if (code === "PAGE_DRAFT_SHARD_NOT_READY") return "Retrieve every cursor for the returned draft shard before committing it; accepted earlier shards remain durable."
  if (code === "INCOMPLETE_PAGE_COVERAGE") return "Add the reported missing coverage to the rejected set and resubmit it; no patch from the rejected call was stored."
  if (code === "DUPLICATE_PAGE_COVERAGE") return "Keep every requirement ID on one canonical path, repair all reported duplicate owners, and resubmit the whole rejected set."
  if (["FILE_HASH_CONFLICT", "PROVISIONAL_PAGE_CONFLICT"].includes(code)) return "Rebase the conflicting target, then resubmit the whole rejected atomic patch set; do not retry only one patch."
  return "Correct every reported invalid patch and resubmit the whole rejected atomic patch set with a new idempotency key; do not retry only the failing patch."
}

function recoveryAction(tool, args, error) {
  if (tool === "llm_wiki_commit_analysis" && RECOVERABLE_ANALYSIS_CODES.has(error.code)) {
    return { tool, arguments: { task_id: args?.task_id, batch_id: args?.batch_id } }
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
  if (tool === "llm_wiki_commit_pages" && error.code === "PAGE_PLAN_INCOMPLETE") {
    return {
      tool: "llm_wiki_get_page_plan_context",
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
      arguments: {
        task_id: args?.task_id,
        writer_id: args?.writer_id,
        projection_id: args?.projection_id,
        view: "draft-shard",
        shard_id: error.details.next_draft_shard.shard_id,
        cursor: 0,
        max_chars: 40_000,
      },
    }
  }
  if (tool === "llm_wiki_commit_pages" && ["INVALID_PAGE_PATCH", "INVALID_PAGE_PATH", "INVALID_SOURCE_REF", "INCOMPLETE_PAGE_COVERAGE", "DUPLICATE_PAGE_COVERAGE", "PAGE_COMMIT_TOO_LARGE"].includes(error.code)) {
    return {
      tool,
      arguments: {
        task_id: args?.task_id,
        writer_id: args?.writer_id,
        projection_id: args?.projection_id,
        based_on_wiki_revision: args?.based_on_wiki_revision,
        projection_complete: args?.projection_complete !== false,
      },
    }
  }
  if (tool === "llm_wiki_get_page_plan_context" && ["PAGE_PLAN_CURSOR_MISMATCH", "PAGE_PLAN_SNAPSHOT_MISSING", "PAGE_DRAFT_SHARD_NOT_FOUND"].includes(error.code)) {
    return {
      tool,
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

export class HeadlessToolRouter {
  constructor(core) {
    this.core = core
  }

  listTools() {
    return TOOL_DEFINITIONS
  }

  async call(name, args = {}) {
    switch (name) {
      case "llm_wiki_import_files": return this.core.importFiles(args)
      case "llm_wiki_get_batch": return this.core.getBatch(args)
      case "llm_wiki_get_domain_schema": return this.core.getDomainSchema(args)
      case "llm_wiki_retrieve_context": return this.core.retrieveContext(args)
      case "llm_wiki_commit_analysis": return this.core.commitAnalysis(args)
      case "llm_wiki_get_page_plan_context": return this.core.getPagePlanContext(args)
      case "llm_wiki_apply_projection": return this.core.applyWikiProjection(args)
      case "llm_wiki_commit_pages": return this.core.commitPages(args)
      case "llm_wiki_finalize": return this.core.finalize(args)
      case "llm_wiki_status": return this.core.status(args)
      case "llm_wiki_list_tasks": return this.core.listTasks(args)
      case "llm_wiki_delete_knowledge_base": return this.core.deleteKnowledgeBase(args)
      case "llm_wiki_abort": return this.core.abort(args)
      case "llm_wiki_lint": return this.core.lint(args)
      default: throw new LlmWikiError("TOOL_NOT_FOUND", `Unknown llm_wiki tool: ${name}`)
    }
  }

  async callMcp(name, args = {}) {
    try {
      const inputBytes = Buffer.byteLength(JSON.stringify(args))
      if (inputBytes > MAX_MCP_INPUT_BYTES) {
        throw new LlmWikiError("MCP_INPUT_TOO_LARGE", `Tool input exceeds the ${MAX_MCP_INPUT_BYTES}-byte MCP limit. Submit smaller batches.`, { retryable: true })
      }
      return serializeResult(await this.call(name, args))
    } catch (error) {
      try {
        return serializeResult(errorResult(error, { tool: name, args }))
      } catch {
        // No tool-level error, including a serialization failure while
        // reporting another error, is allowed to reject the MCP request and
        // destabilize the long-lived STDIO transport.
        return emergencyMcpResult()
      }
    }
  }
}
