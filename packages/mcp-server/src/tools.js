import { LlmWikiError, asLlmWikiError } from "@llm-wiki/core"
import { TOOL_DEFINITIONS } from "./tool-definitions.js"

const MAX_MCP_INPUT_BYTES = 12 * 1024 * 1024
const MAX_MCP_OUTPUT_BYTES = 6 * 1024 * 1024
const STRUCTURED_CONTENT_DUPLICATION_LIMIT = 128 * 1024
const MAX_ERROR_MESSAGE_CHARS = 2_000
const RECOVERABLE_ANALYSIS_CODES = new Set(["INVALID_ANALYSIS", "INVALID_DOMAIN_ANALYSIS", "INVALID_SOURCE_REF", "ANALYSIS_TOO_LARGE"])

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
  const errorData = { ...normalized.toJSON(), retryable: normalized.retryable || analysisRetry }
  return {
    ok: false,
    accepted: false,
    rejected: true,
    error: errorData,
    ...(Array.isArray(normalized.details?.validation_errors)
      ? { validation_errors: normalized.details.validation_errors }
      : analysisRetry ? { validation_errors: [normalized.message] } : {}),
    next_action: recoveryAction(context.tool, context.args, normalized),
    mcp_connection_usable: true,
  }
}

function recoveryAction(tool, args, error) {
  if (tool === "llm_wiki_commit_analysis" && RECOVERABLE_ANALYSIS_CODES.has(error.code)) {
    return { tool, arguments: { task_id: args?.task_id, batch_id: args?.batch_id } }
  }
  if (tool === "llm_wiki_get_batch" && error.code === "MCP_OUTPUT_TOO_LARGE") {
    return { tool, arguments: { task_id: args?.task_id, batch_id: args?.batch_id } }
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
      case "llm_wiki_retrieve_context": return this.core.retrieveContext(args)
      case "llm_wiki_commit_analysis": return this.core.commitAnalysis(args)
      case "llm_wiki_get_page_plan_context": return this.core.getPagePlanContext(args)
      case "llm_wiki_commit_pages": return this.core.commitPages(args)
      case "llm_wiki_finalize": return this.core.finalize(args)
      case "llm_wiki_status": return this.core.status(args)
      case "llm_wiki_list_tasks": return this.core.listTasks(args)
      case "llm_wiki_abort": return this.core.abort(args)
      case "llm_wiki_lint": return this.core.lint(args)
      default: throw new LlmWikiError("TOOL_NOT_FOUND", `Unknown llm_wiki tool: ${name}`)
    }
  }

  async callMcp(name, args = {}) {
    try {
      const inputBytes = Buffer.byteLength(JSON.stringify(args))
      if (inputBytes > MAX_MCP_INPUT_BYTES) {
        throw new LlmWikiError("MCP_INPUT_TOO_LARGE", `Tool input exceeds the ${MAX_MCP_INPUT_BYTES}-byte MCP limit. Submit smaller batches.`)
      }
      return serializeResult(await this.call(name, args))
    } catch (error) {
      return serializeResult(errorResult(error, { tool: name, args }))
    }
  }
}
