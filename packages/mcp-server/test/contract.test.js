import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
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
  const drafter = await readFile(new URL("../../../.claude/agents/llm-wiki-page-drafter.md", import.meta.url), "utf8")
  const settings = JSON.parse(await readFile(new URL("../../../.claude/settings.json", import.meta.url), "utf8"))
  const skill = await readFile(new URL("../../../.agents/skills/llm-wiki-builder/SKILL.md", import.meta.url), "utf8")

  for (const agent of [extractor, writer]) {
    assert.doesNotMatch(agent, /^tools:/m)
    assert.match(agent, /^disallowedTools:/m)
    assert.match(agent, /^mcpServers:\n  - llm-wiki$/m)
    assert.match(agent, /^permissionMode: dontAsk$/m)
    assert.match(agent, /ToolSearch/)
  }
  assert.match(drafter, /^tools: \[\]$/m)
  assert.match(drafter, /^disallowedTools:.*ToolSearch$/m)
  assert.match(drafter, /^mcpServers:\n  - llm-wiki$/m)
  assert.match(drafter, /llm_wiki_stage_page_drafts/)
  assert.match(drafter, /never returns page bodies/i)
  assert.match(drafter, /^permissionMode: dontAsk$/m)
  assert.match(drafter, /one bounded shard/)
  assert.match(drafter, /no duplicate paths/)
  assert.equal(settings.enableAllProjectMcpServers, true)
  const sessionStartHook = settings.hooks.SessionStart[0].hooks[0]
  assert.equal(sessionStartHook.command, "node")
  assert.deepEqual(sessionStartHook.args, [
    "${CLAUDE_PROJECT_DIR}/packages/mcp-server/dist/ensure-daemon.js",
    "--workspace",
    "${CLAUDE_PROJECT_DIR}",
  ])
  assert.equal(settings.permissions.allow.includes("Agent(llm-wiki-extractor)"), true)
  assert.equal(settings.permissions.allow.includes("Agent(llm-wiki-page-drafter)"), true)
  assert.equal(settings.permissions.allow.includes("Agent(llm-wiki-writer)"), true)
  assert.equal(settings.permissions.allow.includes("ToolSearch"), true)
  assert.equal(settings.permissions.allow.includes("mcp__llm-wiki"), true)
  assert.equal(settings.permissions.allow.includes("mcp__llm-wiki__*"), true)
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(settings.permissions.allow.includes(`mcp__llm-wiki__${tool.name}`), true)
  }
  assert.doesNotMatch(skill, /mode=capability-probe/)
  assert.match(skill, /calling `llm_wiki_status` directly in the coordinator/)
  assert.match(skill, /Agent\/Team initialization errors do not prove MCP readiness/)
  assert.match(skill, /do not simultaneously run\s+the same extraction quantum in the coordinator/)
  assert.match(skill, /do not retry with a\s+`general-purpose`/)
  assert.match(skill, /Agent type\s+`llm-wiki-extractor` explicitly/)
  assert.match(skill, /Never launch these slots as `general-purpose`/)
  assert.match(skill, /worker_batch_quantum/)
  assert.match(skill, /never more than six/)
  assert.match(skill, /commits a durable checkpoint after every batch/)
  assert.match(skill, /same\s+`worker_id`/)
  assert.match(skill, /Never claim that MCP is "unreliable across\s+turns"/)
  assert.match(skill, /running_worker_ids/)
  assert.match(skill, /immediately relaunch\s+`llm-wiki-extractor` with that same worker ID/)
  assert.match(skill, /never wait\s+for lease expiry/)
  assert.match(skill, /Never say "both leases active, waiting\s+for the other Agent"/)
  assert.match(skill, /level\s+`"domains"`/)
  assert.match(skill, /progressive-directory-v2/)
  assert.match(skill, /classification_scaffold/)
  assert.match(skill, /be_pointer_hints/)
  assert.match(extractor, /plain string, never an object/)
  assert.match(skill, /Skip\s+`llm_wiki_retrieve_context` by default/)
  assert.match(skill, /do not call `llm_wiki_status` inside this\s+worker/)
  assert.match(skill, /Start by copying `analysis_scaffold`/)
  assert.match(skill, /server has already generated exact quotes/)
  assert.match(skill, /never retype a quote, read the\s+original source file/)
  assert.match(extractor, /cite `evidence_index` values directly/)
  assert.match(extractor, /including `batch_count: 1`/)
  assert.match(skill, /at most two `commit_analysis` attempts for each batch/)
  assert.match(writer, /Normal mode: staged receipts only/)
  assert.match(writer, /never launches or asks to\s+launch a Drafter/)
  assert.match(writer, /waiting_for_drafter_receipts/)
  assert.match(writer, /After one accepted staged wave, stop/)
  assert.match(writer, /action_owner: "coordinator"/)
  assert.match(writer, /300–1,200 characters/)
  assert.match(writer, /stable server-side Wiki committer/)
  assert.match(writer, /main coordinator owns the\s+projection manifest/)
  assert.match(skill, /incremental projection leases at most eight batches/)
  assert.match(skill, /coordinator projection loop uses only\s+`llm_wiki_get_page_plan_context`/)
  assert.match(skill, /must never call\s+`llm_wiki_get_staged_page_drafts` or `llm_wiki_commit_pages`/)
  assert.match(writer, /`patches: \[\]` is the required staged-commit form/)
  assert.match(skill, /`llm_wiki_apply_projection`\s+is only a compatibility redirect/)
  assert.match(writer, /stable Wiki committer/)
  assert.match(writer, /^disallowedTools: Agent,/m)
  assert.match(writer, /explicit-serial-writer-fallback-only/)
  assert.match(writer, /Never import or extract sources, launch Agents, coordinate Drafters/)
  assert.match(skill, /at most four concurrent/)
  assert.match(skill, /background subagents cannot reliably spawn nested subagents/)
  assert.match(skill, /path is indivisible.*requirement sharing\s+`patch_scaffold\.path`/s)
  assert.match(skill, /parallel draft generation must\s+never become parallel commits/)
  assert.match(skill, /must launch project Agent\s+`llm-wiki-page-drafter`/)
  assert.match(skill, /coordinator-owned-parallel-drafters/)
  assert.match(skill, /Launch the stable `llm-wiki-writer` only\s+after at least one Drafter stages a shard/)
  assert.match(skill, /A Writer launched without hash-bound receipts must return\s+`waiting_for_drafter_receipts`/)
  assert.match(skill, /Do not pass a manifest or\s+`draft-shard` action to that Writer/)
  assert.doesNotMatch(skill, /inspect `writer_next_action`/)
  assert.match(skill, /Never generate an oversized patch set and split it afterward/)
  assert.match(skill, /Do not traverse every manifest\s+shard before drafting/)
  assert.match(skill, /Background-agent priority \(mandatory\)/)
  assert.match(skill, /including a task with exactly one batch/)
  assert.match(skill, /Do not call `llm_wiki_get_batch` or perform semantic extraction in the main/)
  assert.match(skill, /only after a worker creation was attempted and failed/)
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
    "llm_wiki_apply_projection",
    "llm_wiki_stage_page_drafts",
    "llm_wiki_get_staged_page_drafts",
    "llm_wiki_commit_pages",
    "llm_wiki_update_pages",
    "llm_wiki_finalize",
    "llm_wiki_status",
    "llm_wiki_list_tasks",
    "llm_wiki_delete_knowledge_base",
    "llm_wiki_abort",
    "llm_wiki_lint",
  ])
  assert.equal(names.includes("llm_wiki_projects"), false)
  assert.equal(names.includes("llm_wiki_chat"), false)
  assert.equal(new Set(names).size, names.length)
  assert.match(TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_import_files").description, /background-agent-first extraction even when batch_count=1/)
  const importOptions = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_import_files").inputSchema.properties.options.properties
  assert.equal(importOptions.domain_schema, undefined)
  assert.match(importOptions.domain_schema_path.description, /progressive-directory-v2/)
  const schemaProperties = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_get_domain_schema").inputSchema.properties
  assert.deepEqual(Object.keys(schemaProperties).sort(), ["abe_file", "domain_folder", "level", "task_id"])
  for (const tool of TOOL_DEFINITIONS) {
    assert.match(tool.name, /^llm_wiki_[a-z_]+$/)
    assert.equal(typeof tool.description, "string")
    assert.equal(tool.description.length > 20, true)
    assert.equal(tool.inputSchema.type, "object")
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(Array.isArray(tool.inputSchema.required), true)
    assert.equal(tool._meta["anthropic/alwaysLoad"], true)
    assert.equal(Number.isInteger(tool._meta["anthropic/maxResultSizeChars"]), true)
    assert.equal(tool._meta["anthropic/maxResultSizeChars"] >= 80_000, true)
  }
  const pagePlan = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_get_page_plan_context")
  assert.deepEqual(pagePlan.inputSchema.properties.view.enum, ["plan", "manifest", "draft-shard"])
  assert.equal(typeof pagePlan.inputSchema.properties.shard_id, "object")
  const pageCommit = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_commit_pages")
  assert.equal(pageCommit.inputSchema.properties.patches.maxItems, 50)
  assert.equal(pageCommit.inputSchema.properties.staged_draft_shard_ids.maxItems, 8)
  assert.equal(pageCommit.inputSchema.properties.staged_draft_receipts.maxItems, 8)
  assert.match(pageCommit.description, /Hard maximum: 50 patches/)
  assert.match(pageCommit.description, /staged_draft_receipts/)
  const stagedDrafts = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_get_staged_page_drafts")
  assert.equal(stagedDrafts.inputSchema.required.includes("draft_receipts"), true)
  assert.equal(stagedDrafts.inputSchema.properties.draft_receipts.minItems, 1)
  const pageUpdate = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_update_pages")
  assert.deepEqual(pageUpdate.inputSchema.properties.action.enum, ["inspect", "apply"])
  assert.equal(pageUpdate.inputSchema.properties.updates.maxItems, 20)
  assert.deepEqual(pageUpdate.inputSchema.properties.updates.items.properties.changes.items.properties.operation.enum, ["upsert_section", "replace_section", "append_to_section", "remove_section"])
  assert.match(pageUpdate.description, /rebuilds retrieval indexes/i)
  assert.match(pagePlan.description, /parallel drafting.*coordinator/i)
  assert.match(pagePlan.description, /sole committer/i)
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

test("oversized next_action is reduced once and cannot OOM the MCP process", async () => {
  const huge = {
    ok: false,
    accepted: false,
    error: { code: "TOOL_FAILED", message: "large result" },
    next_action: { tool: "llm_wiki_list_tasks", arguments: { payload: "x".repeat(600_000) } },
  }
  const router = new HeadlessToolRouter({ listTasks: async () => huge })
  const response = await router.callMcp("llm_wiki_list_tasks", {})
  const result = JSON.parse(response.content[0].text)
  assert.equal(result.error.code, "TOOL_FAILED")
  assert.deepEqual(result.next_action, { tool: "llm_wiki_list_tasks", arguments: {} })
  assert.equal(Buffer.byteLength(response.content[0].text) < 450 * 1024, true)
  assert.equal((await router.callMcp("llm_wiki_list_tasks", {})).content.length, 1)

  const toolsModuleUrl = new URL("../src/tools.js", import.meta.url).href
  const childScript = [
    `import { HeadlessToolRouter } from ${JSON.stringify(toolsModuleUrl)}`,
    'const huge = { next_action: { tool: "llm_wiki_list_tasks", arguments: { payload: "x".repeat(600000) } }, ok: true }',
    'const router = new HeadlessToolRouter({ listTasks: async () => huge })',
    'const response = await router.callMcp("llm_wiki_list_tasks", {})',
    'process.stdout.write(response.content[0].text)',
  ].join(";")
  const child = spawn(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", childScript], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += String(chunk) })
  child.stderr.on("data", (chunk) => { stderr += String(chunk) })
  const exitCode = await new Promise((resolve) => child.once("close", resolve))
  assert.equal(exitCode, 0, stderr)
  assert.equal(JSON.parse(stdout).error.code, "MCP_OUTPUT_TOO_LARGE")
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
      worker_id: "extractor-4",
      analysis: {},
      idempotency_key: "contract-retry-v1",
    })
    assert.equal(response.isError, undefined)
    assert.equal(response.structuredContent.accepted, false)
    assert.equal(response.structuredContent.error.code, code)
    assert.deepEqual(response.structuredContent.validation_errors, ["fix this field"])
    assert.equal(response.structuredContent.next_action.tool, "llm_wiki_commit_analysis")
    assert.equal(response.structuredContent.next_action.arguments.worker_id, "extractor-4")
    assert.deepEqual(response.structuredContent.worker_restart, {
      required: true,
      strategy: "restart-same-worker-id-immediately",
      worker_id: "extractor-4",
      batch_id: "batch-0001",
      delay_ms: 0,
    })
  }
})

test("an expired or missing extraction lease recovers through get_batch without disconnecting MCP", async () => {
  const router = new HeadlessToolRouter({
    commitAnalysis: async () => {
      throw new LlmWikiError("BATCH_LEASE_REQUIRED", "Lease must be renewed.", { retryable: true })
    },
  })
  const response = await router.callMcp("llm_wiki_commit_analysis", {
    task_id: "task-example",
    batch_id: "batch-0007",
    worker_id: "extractor-2",
    analysis: {},
    idempotency_key: "lease-recovery-v1",
  })
  assert.equal(response.isError, undefined)
  assert.equal(response.structuredContent.error.code, "BATCH_LEASE_REQUIRED")
  assert.deepEqual(response.structuredContent.next_action, {
    tool: "llm_wiki_get_batch",
    arguments: { task_id: "task-example", batch_id: "batch-0007", worker_id: "extractor-2" },
  })
  assert.equal(response.structuredContent.mcp_connection_usable, true)
})

test("premature page commits return the exact next page-plan cursor without disconnecting MCP", async () => {
  const router = new HeadlessToolRouter({
    commitPages: async () => {
      throw new LlmWikiError("PAGE_PLAN_INCOMPLETE", "Collect all cursors first.", {
        retryable: true,
        details: { expected_cursor: 63 },
      })
    },
  })
  const response = await router.callMcp("llm_wiki_commit_pages", {
    task_id: "task-example",
    writer_id: "wiki-writer-1",
    projection_id: "projection-example",
    based_on_wiki_revision: "a".repeat(64),
    patches: [],
    idempotency_key: "premature-page-plan-v1",
  })
  assert.equal(response.isError, undefined)
  assert.equal(response.structuredContent.error.code, "PAGE_PLAN_INCOMPLETE")
  assert.equal(response.structuredContent.mcp_connection_usable, true)
  assert.deepEqual(response.structuredContent.next_action, {
    tool: "llm_wiki_get_page_plan_context",
    action_owner: "coordinator",
    delegate_to: "llm-wiki-page-drafter",
    arguments: {
      task_id: "task-example",
      writer_id: "wiki-writer-1",
      projection_id: "projection-example",
      view: "manifest",
      cursor: 0,
      max_chars: 40_000,
    },
  })
})

test("page validation rejection reports atomic whole-subset retry semantics", async () => {
  const router = new HeadlessToolRouter({
    commitPages: async () => {
      throw new LlmWikiError("INVALID_SOURCE_REF", "Two page patches have invalid quotes.", {
        retryable: true,
        details: {
          validation_errors: [
            { patch_id: "patch-035", code: "INVALID_SOURCE_REF" },
            { patch_id: "patch-041", code: "INVALID_SOURCE_REF" },
          ],
        },
      })
    },
  })
  const response = await router.callMcp("llm_wiki_commit_pages", {
    task_id: "task-example",
    writer_id: "wiki-writer-1",
    projection_id: "projection-example",
    based_on_wiki_revision: "b".repeat(64),
    projection_complete: true,
    patches: [{ patchId: "patch-035" }, { patchId: "patch-041" }, { patchId: "patch-042" }],
    idempotency_key: "page-validation-retry-v1",
  })
  assert.equal(response.isError, undefined)
  assert.equal(response.structuredContent.error.code, "INVALID_SOURCE_REF")
  assert.equal(response.structuredContent.atomic_commit_applied, false)
  assert.deepEqual(response.structuredContent.page_commit_recovery, {
    changes_applied: false,
    retry_scope: "entire_rejected_patch_set",
    submitted_patch_count: 3,
    submitted_patch_ids: ["patch-035", "patch-041", "patch-042"],
    preserve_projection_complete: true,
    instruction: "Correct every reported invalid patch and resubmit the whole rejected atomic patch set with a new idempotency key; do not retry only the failing patch.",
  })
  assert.deepEqual(response.structuredContent.next_action, {
    tool: "llm_wiki_commit_pages",
    action_owner: "writer",
    delegate_to: "llm-wiki-writer",
    arguments: {
      task_id: "task-example",
      writer_id: "wiki-writer-1",
      projection_id: "projection-example",
      based_on_wiki_revision: "b".repeat(64),
      projection_complete: true,
    },
  })
  assert.equal(response.structuredContent.mcp_connection_usable, true)
})

test("unfinished server-side page shards recover without restarting or disconnecting", async () => {
  const nextShard = { shard_id: "draft-0007", paths: ["wiki/entities/example.md"], requirement_ids: ["page-example"] }
  const router = new HeadlessToolRouter({
    commitPages: async () => {
      throw new LlmWikiError("PAGE_DRAFT_SHARDS_INCOMPLETE", "Draft shards remain.", {
        retryable: true,
        details: { missing_shard_count: 3, next_draft_shard: nextShard },
      })
    },
  })
  const response = await router.callMcp("llm_wiki_commit_pages", {
    task_id: "task-example",
    writer_id: "wiki-writer-1",
    projection_id: "projection-example",
    based_on_wiki_revision: "c".repeat(64),
    projection_complete: true,
    patches: [],
    idempotency_key: "unfinished-shards-v1",
  })
  assert.equal(response.isError, undefined)
  assert.equal(response.structuredContent.error.code, "PAGE_DRAFT_SHARDS_INCOMPLETE")
  assert.equal(response.structuredContent.atomic_commit_applied, false)
  assert.equal(response.structuredContent.mcp_connection_usable, true)
  assert.deepEqual(response.structuredContent.next_action, {
    tool: "llm_wiki_get_page_plan_context",
    action_owner: "coordinator",
    delegate_to: "llm-wiki-page-drafter",
    arguments: {
      task_id: "task-example",
      writer_id: "wiki-writer-1",
      projection_id: "projection-example",
      view: "draft-shard",
      shard_id: "draft-0007",
      cursor: 0,
      max_chars: 40_000,
    },
  })
})

test("parallel draft coverage conflicts remain recoverable without disconnecting MCP", async () => {
  const router = new HeadlessToolRouter({
    commitPages: async () => {
      throw new LlmWikiError("DUPLICATE_PAGE_COVERAGE", "Requirement is owned by two paths.", {
        retryable: true,
        details: { duplicate_page_requirements: [{ requirement_id: "page-example", paths: ["wiki/entities/a.md", "wiki/entities/b.md"] }] },
      })
    },
  })
  const response = await router.callMcp("llm_wiki_commit_pages", {
    task_id: "task-example",
    writer_id: "wiki-writer-1",
    projection_id: "projection-example",
    based_on_wiki_revision: "a".repeat(64),
    patches: [{ patchId: "patch-a" }, { patchId: "patch-b" }],
    idempotency_key: "duplicate-coverage-v1",
  })
  assert.equal(response.isError, undefined)
  assert.equal(response.structuredContent.error.code, "DUPLICATE_PAGE_COVERAGE")
  assert.equal(response.structuredContent.atomic_commit_applied, false)
  assert.equal(response.structuredContent.page_commit_recovery.retry_scope, "entire_rejected_patch_set_after_unique_coverage_reconciliation")
  assert.equal(response.structuredContent.next_action.tool, "llm_wiki_commit_pages")
  assert.equal(response.structuredContent.mcp_connection_usable, true)
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
    stagePageDrafts: failing,
    getStagedPageDrafts: failing,
    applyWikiProjection: failing,
    commitPages: failing,
    updatePages: failing,
    finalize: failing,
    status: failing,
    listTasks: failing,
    deleteKnowledgeBase: failing,
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
  const excessiveData = JSON.parse(excessive.content[0].text)
  assert.equal(excessive.structuredContent, undefined)
  assert.equal(excessiveData.error.code, "MCP_OUTPUT_TOO_LARGE")
  assert.equal(excessiveData.mcp_connection_usable, true)

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
  const excessiveErrorData = JSON.parse(excessiveError.content[0].text)
  assert.equal(excessiveError.structuredContent, undefined)
  assert.equal(excessiveErrorData.error.code, "INVALID_ANALYSIS")
  assert.equal(excessiveErrorData.error.details.truncated, true)
  assert.equal(excessiveErrorData.mcp_connection_usable, true)
})

test("MCP backpressure returns a recoverable busy result without growing an unbounded task queue", async () => {
  let releasePending
  const pending = new Promise((resolve) => { releasePending = resolve })
  const router = new HeadlessToolRouter({
    listTasks: async () => {
      await pending
      return { tasks: [] }
    },
  })
  const calls = Array.from({ length: 5 }, () => router.callMcp("llm_wiki_list_tasks", { task_id: "task-backpressure" }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(router.runtimeStats().activeCalls, 4)
  const busy = await calls[4]
  assert.equal(busy.isError, undefined)
  assert.equal(busy.structuredContent.error.code, "TASK_BUSY")
  assert.equal(busy.structuredContent.mcp_connection_usable, true)
  assert.equal(busy.structuredContent.error.details.retry_after_ms, 1_500)
  releasePending()
  const completed = await Promise.all(calls.slice(0, 4))
  assert.equal(completed.every((result) => result.structuredContent.tasks.length === 0), true)
  assert.equal(router.runtimeStats().activeCalls, 0)
})

test("a pre-cancelled MCP request is rejected before it can enter Core", async () => {
  let called = false
  const router = new HeadlessToolRouter({
    listTasks: async () => {
      called = true
      return { tasks: [] }
    },
  })
  const controller = new AbortController()
  controller.abort()
  const response = await router.callMcp("llm_wiki_list_tasks", { task_id: "task-cancelled" }, { signal: controller.signal })
  assert.equal(response.isError, undefined)
  assert.equal(response.structuredContent.error.code, "MCP_REQUEST_CANCELLED")
  assert.equal(response.structuredContent.mcp_connection_usable, true)
  assert.equal(called, false)
})
