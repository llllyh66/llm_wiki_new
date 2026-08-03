import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { LlmWikiCore, LlmWikiError } from "../../core/src/index.js"
import { TOOL_DEFINITIONS } from "../src/tool-definitions.js"
import { HeadlessToolRouter } from "../src/tools.js"

const textResult = (result) => JSON.parse(result.content[0].text)

test("Claude project agents inherit llm-wiki MCP without a wildcard-only tool allowlist", async () => {
  const extractor = await readFile(new URL("../../../.claude/agents/llm-wiki-extractor.md", import.meta.url), "utf8")
  const writer = await readFile(new URL("../../../.claude/agents/llm-wiki-writer.md", import.meta.url), "utf8")
  const settings = JSON.parse(await readFile(new URL("../../../.claude/settings.json", import.meta.url), "utf8"))
  const skill = await readFile(new URL("../../../.agents/skills/llm-wiki-builder/SKILL.md", import.meta.url), "utf8")

  for (const agent of [extractor, writer]) {
    assert.doesNotMatch(agent, /^tools:/m)
    assert.match(agent, /^disallowedTools:/m)
    assert.match(agent, /^mcpServers:\n  - llm-wiki$/m)
    assert.match(agent, /^permissionMode: dontAsk$/m)
  }
  assert.equal(settings.enableAllProjectMcpServers, true)
  assert.equal(settings.permissions.allow.includes("mcp__llm-wiki"), true)
  assert.equal(settings.permissions.allow.includes("mcp__llm-wiki__*"), true)
  assert.doesNotMatch(skill, /mode=capability-probe/)
  assert.match(skill, /calling `llm_wiki_status` directly in the coordinator/)
  assert.match(skill, /Agent\/Team initialization errors do not prove MCP readiness/)
  assert.match(skill, /do not simultaneously run\s+the same extraction quantum in the coordinator/)
  assert.match(skill, /do not retry with a\s+`general-purpose`/)
  assert.match(skill, /processes at most one batch/)
  assert.match(skill, /same\s+`worker_id`/)
  assert.match(skill, /Never claim that MCP is "unreliable across\s+turns"/)
  assert.match(skill, /running_worker_ids/)
  assert.match(skill, /Never say "both leases active, waiting\s+for the other Agent"/)
  assert.match(skill, /mode: "search"/)
  assert.match(skill, /do not call `llm_wiki_status` inside this\s+worker/)
  assert.match(skill, /Start by copying `analysis_scaffold`/)
  assert.match(skill, /at most two `commit_analysis` attempts/)
})

test("MCP publishes the complete Agent-first tool contract without desktop tools", () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.name)
  assert.deepEqual(names, [
    "llm_wiki_import_files",
    "llm_wiki_get_batch",
    "llm_wiki_get_domain_schema",
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
  assert.equal(response.isError, undefined)
  assert.equal(response.structuredContent.ok, false)
  assert.equal(response.structuredContent.error.code, "TASK_NOT_FOUND")
  assert.equal(response.structuredContent.mcp_connection_usable, true)
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
    assert.equal(response.isError, undefined, tool.name)
    const result = textResult(response)
    if (result.error) assert.equal(result.mcp_connection_usable, true, tool.name)
  }
  const unknown = await router.callMcp("llm_wiki_unknown", {})
  assert.equal(unknown.isError, undefined)
  assert.equal(unknown.structuredContent.error.code, "TOOL_NOT_FOUND")
  const failing = async () => { throw new LlmWikiError("TEST_TOOL_FAILURE", "Expected tool failure.") }
  const failureRouter = new HeadlessToolRouter({
    importFiles: failing,
    getBatch: failing,
    getDomainSchema: failing,
    retrieveContext: failing,
    commitAnalysis: failing,
    getPagePlanContext: failing,
    commitPages: failing,
    finalize: failing,
    status: failing,
    listTasks: failing,
    abort: failing,
    lint: failing,
  })
  for (const tool of TOOL_DEFINITIONS) {
    const response = await failureRouter.callMcp(tool.name, {})
    assert.equal(response.isError, undefined, tool.name)
    assert.equal(response.structuredContent.error.code, "TEST_TOOL_FAILURE", tool.name)
    assert.equal(response.structuredContent.mcp_connection_usable, true, tool.name)
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
  assert.equal(excessive.isError, undefined)
  assert.equal(excessive.structuredContent.error.code, "MCP_OUTPUT_TOO_LARGE")
  assert.equal(excessive.structuredContent.mcp_connection_usable, true)

  const largeErrorRouter = new HeadlessToolRouter({
    listTasks: async () => { throw new LlmWikiError("INVALID_ANALYSIS", "Invalid analysis.", { details: { validation_errors: ["x".repeat(160 * 1024)] } }) },
  })
  const largeError = await largeErrorRouter.callMcp("llm_wiki_list_tasks", {})
  assert.equal(largeError.isError, undefined)
  assert.equal(largeError.structuredContent, undefined)
  assert.equal(JSON.parse(largeError.content[0].text).error.code, "INVALID_ANALYSIS")

  const excessiveErrorRouter = new HeadlessToolRouter({
    listTasks: async () => { throw new LlmWikiError("INVALID_ANALYSIS", "Invalid analysis.", { details: { validation_errors: ["x".repeat(6 * 1024 * 1024 + 1)] } }) },
  })
  const excessiveError = await excessiveErrorRouter.callMcp("llm_wiki_list_tasks", {})
  assert.equal(excessiveError.isError, undefined)
  assert.equal(excessiveError.structuredContent.error.code, "INVALID_ANALYSIS")
  assert.equal(excessiveError.structuredContent.error.details.truncated, true)
  assert.equal(excessiveError.structuredContent.mcp_connection_usable, true)
})
