import { LlmWikiError, asLlmWikiError } from "@llm-wiki/core"
import { TOOL_DEFINITIONS } from "./tool-definitions.js"

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
      const data = await this.call(name, args)
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      }
    } catch (error) {
      const normalized = asLlmWikiError(error)
      const data = { error: normalized.toJSON() }
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      }
    }
  }
}
