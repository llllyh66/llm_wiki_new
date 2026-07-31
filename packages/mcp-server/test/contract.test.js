import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { LlmWikiCore } from "../../core/src/index.js"
import { TOOL_DEFINITIONS } from "../src/tool-definitions.js"
import { HeadlessToolRouter } from "../src/tools.js"

test("MCP publishes the complete Agent-first tool contract without desktop tools", () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.name)
  assert.deepEqual(names, [
    "llm_wiki_import_files",
    "llm_wiki_get_batch",
    "llm_wiki_retrieve_context",
    "llm_wiki_commit_analysis",
    "llm_wiki_get_page_plan_context",
    "llm_wiki_commit_pages",
    "llm_wiki_finalize",
    "llm_wiki_status",
    "llm_wiki_list_tasks",
    "llm_wiki_abort",
    "llm_wiki_lint",
  ])
  assert.equal(names.includes("llm_wiki_projects"), false)
  assert.equal(names.includes("llm_wiki_chat"), false)
  for (const tool of TOOL_DEFINITIONS) assert.equal(tool.inputSchema.additionalProperties, false)
})

test("MCP router returns structured Core errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-mcp-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const router = new HeadlessToolRouter(await LlmWikiCore.open(root))
  const response = await router.callMcp("llm_wiki_status", { task_id: "outside" })
  assert.equal(response.isError, true)
  assert.equal(response.structuredContent.error.code, "TASK_NOT_FOUND")
})
