import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { LlmWikiCore, LlmWikiError } from "../../core/src/index.js"
import { TOOL_DEFINITIONS } from "../src/tool-definitions.js"
import { HeadlessToolRouter } from "../src/tools.js"

const textResult = (result) => JSON.parse(result.content[0].text)

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
  assert.equal(new Set(names).size, names.length)
  for (const tool of TOOL_DEFINITIONS) {
    assert.match(tool.name, /^llm_wiki_[a-z_]+$/)
    assert.equal(typeof tool.description, "string")
    assert.equal(tool.description.length > 20, true)
    assert.equal(tool.inputSchema.type, "object")
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(Array.isArray(tool.inputSchema.required), true)
  }
})

test("MCP router returns structured Core errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-mcp-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const router = new HeadlessToolRouter(await LlmWikiCore.open(root))
  const response = await router.callMcp("llm_wiki_status", { task_id: "outside" })
  assert.equal(response.isError, true)
  assert.equal(response.structuredContent, undefined)
  assert.equal(textResult(response).error.code, "TASK_NOT_FOUND")
})

test("commit_analysis validation failures are recoverable business results, not MCP errors", async () => {
  for (const code of ["INVALID_ANALYSIS", "INVALID_DOMAIN_ANALYSIS", "INVALID_SOURCE_REF", "ANALYSIS_TOO_LARGE"]) {
    const router = new HeadlessToolRouter({
      commitAnalysis: async () => {
        throw new LlmWikiError(code, `Recoverable ${code}.`, { details: { validation_errors: ["fix this field"] } })
      },
    })
    const response = await router.callMcp("llm_wiki_commit_analysis", {
      task_id: "task-example",
      batch_id: "batch-0001",
      analysis: {},
      idempotency_key: "contract-retry-v1",
    })
    assert.equal(response.isError, undefined)
    assert.equal(response.structuredContent.accepted, false)
    assert.equal(response.structuredContent.error.code, code)
    assert.deepEqual(response.structuredContent.validation_errors, ["fix this field"])
    assert.equal(response.structuredContent.next_action.tool, "llm_wiki_commit_analysis")
  }
})

test("every registered MCP tool routes errors without terminating the router", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-mcp-routes-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const router = new HeadlessToolRouter(await LlmWikiCore.open(root))
  for (const tool of TOOL_DEFINITIONS) {
    const response = await router.callMcp(tool.name, {})
    assert.equal(Array.isArray(response.content), true, tool.name)
  }
  const afterErrors = await router.callMcp("llm_wiki_list_tasks", {})
  assert.equal(afterErrors.isError, undefined)
  assert.deepEqual(afterErrors.structuredContent.tasks, [])
})

test("large MCP results cross the wire once and over-budget results become recoverable errors", async () => {
  const largeRouter = new HeadlessToolRouter({
    listTasks: async () => ({ payload: "x".repeat(160 * 1024) }),
  })
  const large = await largeRouter.callMcp("llm_wiki_list_tasks", {})
  assert.equal(large.isError, undefined)
  assert.equal(large.structuredContent, undefined)
  assert.equal(JSON.parse(large.content[0].text).payload.length, 160 * 1024)

  const excessiveRouter = new HeadlessToolRouter({
    listTasks: async () => ({ payload: "x".repeat(6 * 1024 * 1024 + 1) }),
  })
  const excessive = await excessiveRouter.callMcp("llm_wiki_list_tasks", {})
  assert.equal(excessive.isError, true)
  assert.equal(excessive.structuredContent, undefined)
  assert.equal(textResult(excessive).error.code, "MCP_OUTPUT_TOO_LARGE")

  const largeErrorRouter = new HeadlessToolRouter({
    listTasks: async () => { throw new LlmWikiError("INVALID_ANALYSIS", "Invalid analysis.", { details: { validation_errors: ["x".repeat(160 * 1024)] } }) },
  })
  const largeError = await largeErrorRouter.callMcp("llm_wiki_list_tasks", {})
  assert.equal(largeError.isError, true)
  assert.equal(largeError.structuredContent, undefined)
  assert.equal(JSON.parse(largeError.content[0].text).error.code, "INVALID_ANALYSIS")

  const excessiveErrorRouter = new HeadlessToolRouter({
    listTasks: async () => { throw new LlmWikiError("INVALID_ANALYSIS", "Invalid analysis.", { details: { validation_errors: ["x".repeat(6 * 1024 * 1024 + 1)] } }) },
  })
  const excessiveError = await excessiveErrorRouter.callMcp("llm_wiki_list_tasks", {})
  assert.equal(excessiveError.isError, true)
  assert.equal(excessiveError.structuredContent, undefined)
  assert.equal(textResult(excessiveError).error.code, "INVALID_ANALYSIS")
  assert.equal(textResult(excessiveError).error.details.truncated, true)
})
