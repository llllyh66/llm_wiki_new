import { LlmWikiError, asLlmWikiError } from "@llm-wiki/core"
import { TOOL_DEFINITIONS } from "./tool-definitions.js"

const MAX_MCP_INPUT_BYTES = 12 * 1024 * 1024
const MAX_MCP_OUTPUT_BYTES = 6 * 1024 * 1024
const STRUCTURED_CONTENT_DUPLICATION_LIMIT = 128 * 1024
const MAX_ERROR_MESSAGE_CHARS = 2_000

function serializeResult(data, isError = false) {
  const text = JSON.stringify(data, null, 2)
  const outputBytes = Buffer.byteLength(text)
  if (outputBytes > MAX_MCP_OUTPUT_BYTES) {
    if (!isError) {
      throw new LlmWikiError("MCP_OUTPUT_TOO_LARGE", `Tool output exceeds the ${MAX_MCP_OUTPUT_BYTES}-byte MCP limit. Use pagination or a smaller result limit.`)
    }
    const original = data?.error ?? {}
    return serializeResult({
      error: {
        code: typeof original.code === "string" ? original.code : "TRANSACTION_FAILED",
        message: `${String(original.message ?? "Tool call failed.").slice(0, MAX_ERROR_MESSAGE_CHARS)} (Error details were truncated to keep the MCP connection usable.)`,
        retryable: Boolean(original.retryable),
        ...(original.task_id ? { task_id: original.task_id } : {}),
        details: { truncated: true, original_output_bytes: outputBytes },
        suggested_action: "Submit a smaller payload and correct validation errors in smaller groups.",
      },
    }, true)
  }
  const result = {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text }],
  }
  // Large structured results would otherwise cross the wire twice: once as
  // text and once as structuredContent. This applies to error details too.
  if (outputBytes <= STRUCTURED_CONTENT_DUPLICATION_LIMIT) result.structuredContent = data
  return result
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
      const data = await this.call(name, args)
      return serializeResult(data)
    } catch (error) {
      const normalized = asLlmWikiError(error)
      const data = { error: normalized.toJSON() }
      return serializeResult(data, true)
    }
  }
}
