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

test("CAC project integration mirrors Claude with only client-name substitutions", async () => {
  const files = [
    "settings.json",
    "agents/llm-wiki-extractor.md",
    "agents/llm-wiki-page-drafter.md",
    "agents/llm-wiki-writer.md",
    "skills/llm-wiki-builder/SKILL.md",
  ]
  for (const relativePath of files) {
    const claude = await readFile(new URL(`../../../.claude/${relativePath}`, import.meta.url), "utf8")
    const cac = await readFile(new URL(`../../../.cac/${relativePath}`, import.meta.url), "utf8")
    const expected = claude
      .replaceAll("CLAUDE_PROJECT_DIR", "CAC_PROJECT_DIR")
      .replaceAll("Claude", "CAC")
      .replaceAll("claude", "cac")
    assert.equal(cac, expected, `.cac/${relativePath} must mirror .claude/${relativePath}`)
  }
})

test("CAC documentation does not assume every compatible host installs a cac executable", async () => {
  const readme = await readFile(new URL("../../../.cac/README.md", import.meta.url), "utf8")
  assert.doesNotMatch(readme, /^cac mcp list$/m)
  assert.match(readme, /actual launcher command/i)
})

test("project agents and canonical Skill expose only the current capacity-aware protocol", async () => {
  const extractor = await readFile(new URL("../../../.claude/agents/llm-wiki-extractor.md", import.meta.url), "utf8")
  const writer = await readFile(new URL("../../../.claude/agents/llm-wiki-writer.md", import.meta.url), "utf8")
  const drafter = await readFile(new URL("../../../.claude/agents/llm-wiki-page-drafter.md", import.meta.url), "utf8")
  const settings = JSON.parse(await readFile(new URL("../../../.claude/settings.json", import.meta.url), "utf8"))
  const skill = await readFile(new URL("../../../.agents/skills/llm-wiki-builder/SKILL.md", import.meta.url), "utf8")

  for (const agent of [extractor, writer, drafter]) {
    assert.doesNotMatch(agent, /^tools:/m)
    assert.match(agent, /^disallowedTools:/m)
    assert.match(agent, /^mcpServers:\n  - llm-wiki$/m)
    assert.match(agent, /^permissionMode: dontAsk$/m)
  }
  assert.match(extractor, /^disallowedTools:.*llm_wiki_delete_knowledge_base.*llm_wiki_lint$/m)
  assert.match(writer, /^disallowedTools:.*llm_wiki_delete_knowledge_base.*llm_wiki_lint$/m)
  assert.match(drafter, /^disallowedTools:.*ToolSearch.*llm_wiki_lint$/m)
  assert.match(drafter, /^disallowedTools:.*llm_wiki_update_pages/m)
  assert.match(drafter, /^mcpServers:\n  - llm-wiki$/m)
  assert.match(drafter, /llm_wiki_stage_page_drafts/)
  assert.match(drafter, /^permissionMode: dontAsk$/m)
  assert.match(drafter, /one PagePatch per/)
  assert.match(drafter, /draft_hash/)
  assert.deepEqual(agentMcpTools(extractor), [
    "llm_wiki_commit_analysis",
    "llm_wiki_get_batch",
    "llm_wiki_get_domain_schema",
    "llm_wiki_renew_lease",
    "llm_wiki_retrieve_context",
  ])
  assert.deepEqual(agentMcpTools(drafter), [
    "llm_wiki_get_page_plan_context",
    "llm_wiki_stage_page_drafts",
  ])
  assert.deepEqual(agentMcpTools(writer), [
    "llm_wiki_commit_pages",
    "llm_wiki_get_page_plan_context",
    "llm_wiki_get_staged_page_drafts",
    "llm_wiki_renew_lease",
  ])
  assert.equal(settings.enableAllProjectMcpServers, true)
  assert.equal(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "0")
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
  assert.match(skill, /progressive_import/)
  assert.match(skill, /effective_workers = min\(recommended_workers, max_background_agents_total, host_available_background_slots\)/)
  assert.match(skill, /lease_token/)
  assert.match(skill, /llm_wiki_renew_lease/)
  assert.match(skill, /manifest → draft-shard → staged receipt → single Writer → audited Finalize/)
  assert.match(skill, /running_worker_ids/)
  assert.match(skill, /running_draft_shard_ids/)
  assert.match(skill, /running_writer_projection_ids/)
  assert.match(skill, /Do not say “waiting”/)
  assert.match(skill, /Never call\s+`TeamCreate` or `TeamDelete`, and never pass `team_name`/)
  assert.match(skill, /never relaunch them because a later\s+Team lifecycle message fails/)
  assert.match(skill, /waiting_reason/)
  assert.match(skill, /never means all Extractors must finish/)
  assert.match(skill, /never hard-code a `2 Extractors \+ 1\s+Drafter` topology/)
  assert.match(skill, /may use several concurrently/)
  assert.match(skill, /language of directly supporting source evidence/)
  assert.match(extractor, /language of their directly supporting source evidence/)
  assert.match(drafter, /language of its directly supporting source evidence/)
  assert.match(writer, /source evidence language/)
  assert.match(skill, /completion_gate\.finalize_ready=true/)
  assert.match(skill, /FINALIZE_CATCHUP_REQUIRED/)
  assert.match(skill, /do not ask whether the user wants remaining batches or requirements/i)
  assert.match(extractor, /active lease does not mean this Agent remains alive/)
  assert.match(drafter, /Pending or retrieved shard state does not mean this\s+Drafter remains alive/)
  assert.match(drafter, /draft_claim_token/)
  assert.match(skill, /DRAFT_SHARD_CLAIM_FENCED/)
  assert.match(writer, /projection lease does not mean this\s+Writer remains alive/i)
  assert.match(skill, /feature fallback/)
  assert.match(skill, /retry the exact original tool and arguments/i)
  assert.doesNotMatch(skill, /apply_projection|view.?[=:].?['"]plan|staged_draft_shard_ids|vector\/graph|old server|legacy/i)
})

function agentMcpTools(agent) {
  const deniedLine = agent.match(/^disallowedTools:\s*(.+)$/m)?.[1] ?? ""
  const denied = new Set(deniedLine.split(/,\s*/))
  return TOOL_DEFINITIONS.map((tool) => tool.name)
    .filter((name) => !denied.has(`mcp__llm-wiki__${name}`))
    .sort()
}

test("MCP publishes the complete Agent-first tool contract without desktop tools", () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.name)
  assert.deepEqual(names, [
    "llm_wiki_import_files",
    "llm_wiki_get_batch",
    "llm_wiki_get_domain_schema",
    "llm_wiki_renew_lease",
    "llm_wiki_retrieve_context",
    "llm_wiki_query_domain_pages",
    "llm_wiki_commit_analysis",
    "llm_wiki_get_page_plan_context",
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
  const retrievalTool = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_retrieve_context")
  assert.match(retrievalTool.description, /Search the llm_wiki knowledge base for evidence needed to answer a user's question/)
  assert.match(retrievalTool.description, /Call this before answering factual questions about imported documents or generated Wiki content/)
  assert.match(retrievalTool.description, /Omit batch_id for normal task-wide questions/)
  const importOptions = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_import_files").inputSchema.properties.options.properties
  assert.equal(importOptions.domain_schema, undefined)
  assert.match(importOptions.domain_schema_path.description, /progressive-directory-v2/)
  const schemaProperties = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_get_domain_schema").inputSchema.properties
  assert.deepEqual(Object.keys(schemaProperties).sort(), ["abe_file", "domain_folder", "level", "task_id"])
  const domainPageQuery = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_query_domain_pages")
  assert.deepEqual(domainPageQuery.inputSchema.properties.action.enum, ["inspect", "search"])
  assert.equal(domainPageQuery.inputSchema.properties.paths.maxItems, 20)
  assert.equal(domainPageQuery.inputSchema.properties.limit.maximum, 200)
  assert.equal(domainPageQuery.inputSchema.properties.max_chars.maximum, 240000)
  assert.equal(domainPageQuery.inputSchema.properties.filters.additionalProperties, false)
  assert.equal(domainPageQuery.inputSchema.properties.filters.properties.classification_path_prefix.type, "string")
  assert.match(TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_finalize").description, /Eligible pages are promoted without a second semantic rewrite/)
  assert.match(TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_finalize").description, /FINALIZE_CATCHUP_REQUIRED/)
  const statusTool = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_status")
  assert.match(statusTool.description, /subagent_recovery/)
  assert.match(statusTool.description, /completion_gate/)
  assert.match(statusTool.description, /Extractor, Drafter, and Writer/)
  assert.match(statusTool.description, /cannot observe host process liveness/)
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
  assert.deepEqual(pagePlan.inputSchema.properties.view.enum, ["manifest", "draft-shard"])
  assert.equal(typeof pagePlan.inputSchema.properties.shard_id, "object")
  assert.equal(typeof pagePlan.inputSchema.properties.draft_claim_token, "object")
  const stageDrafts = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_stage_page_drafts")
  assert.equal(stageDrafts.inputSchema.required.includes("draft_claim_token"), true)
  const pageCommit = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_commit_pages")
  assert.equal(pageCommit.inputSchema.properties.patches.maxItems, 50)
  assert.equal(pageCommit.inputSchema.properties.staged_draft_shard_ids, undefined)
  assert.equal(pageCommit.inputSchema.properties.staged_draft_receipts.maxItems, 8)
  assert.deepEqual(retrievalTool.inputSchema.properties.channels.items.enum, ["bm25", "embedding", "wiki"])
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
  assert.match(pagePlan.description, /coordinator.*draft-shard/i)
  assert.match(pagePlan.description, /sole Writer/i)
  const analysisCommit = TOOL_DEFINITIONS.find((tool) => tool.name === "llm_wiki_commit_analysis")
  const analysisInput = analysisCommit.inputSchema.properties.analysis
  assert.equal(analysisInput.additionalProperties, false)
  assert.equal(analysisInput.required.includes("schemaVersion"), true)
  assert.equal(analysisInput.required.includes("sourceRefs"), true)
  assert.equal(analysisInput.required.includes("sourceRefMode"), true)
  assert.equal(analysisInput.properties.sourceRefs.items.type, "integer")
  assert.equal(analysisInput.properties.entities.items.$ref, "#/$defs/analysis_groundedCandidate")
  assert.equal(analysisCommit.inputSchema.$defs.analysis_groundedCandidate.properties.confidence.type, "number")
  assert.deepEqual(analysisCommit.inputSchema.$defs.analysis_groundedCandidate.properties.supportType.enum, ["direct", "normalized", "inferred"])
  assert.equal(analysisCommit.inputSchema.$defs.analysis_groundedCandidate.properties.predicate.type, "string")
  assert.equal(analysisCommit.inputSchema.$defs.analysis_sourceRefList.items.type, "integer")
  assert.equal(analysisCommit.inputSchema.$defs.analysis_groundedCandidate.properties.schemaClassification.properties.snapshotHash.type, "string")
  const schemaText = JSON.stringify(analysisCommit.inputSchema)
  const references = [...schemaText.matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)]
  assert.equal(references.length > 0, true)
  for (const ref of references) {
    assert.equal(Object.hasOwn(analysisCommit.inputSchema.$defs, ref[1]), true, `missing tool schema definition ${ref[1]}`)
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
      required: false,
      strategy: "repair-in-place-same-worker-and-lease",
      worker_id: "extractor-4",
      batch_id: "batch-0001",
      delay_ms: 0,
      preserve_non_failing_candidates: true,
    })
  }
})

test("grounding diagnostics survive MCP serialization and keep the worker in place", async () => {
  const diagnostic = {
    path: "relations[0]",
    reason_code: "UNSUPPORTED_RELATION_PREDICATE",
    field: "predicate",
    predicate: "responsibleFor",
  }
  const router = new HeadlessToolRouter({
    commitAnalysis: async () => {
      throw new LlmWikiError("INVALID_ANALYSIS", "Grounding failed.", {
        details: {
          validation_errors: ["relations[0] predicate is unsupported"],
          grounding_diagnostics: [diagnostic],
          grounding_warnings: [{ reason_code: "HIGH_SOURCE_REF_REUSE", count: 9 }],
        },
      })
    },
  })
  const response = await router.callMcp("llm_wiki_commit_analysis", {
    task_id: "task-example",
    batch_id: "batch-0001",
    worker_id: "extractor-4",
    analysis: {},
    idempotency_key: "grounding-diagnostic-v2",
  })

  assert.deepEqual(response.structuredContent.grounding_diagnostics, [diagnostic])
  assert.equal(response.structuredContent.grounding_warnings[0].reason_code, "HIGH_SOURCE_REF_REUSE")
  assert.equal(response.structuredContent.worker_restart.required, false)
  assert.equal(response.structuredContent.worker_restart.preserve_non_failing_candidates, true)
  assert.equal(response.structuredContent.grounding_repair.exact_quote_copy_required, false)
  assert.equal(response.structuredContent.grounding_repair.repair_scope, "reported-diagnostic-paths-and-fields-only")
  assert.equal(response.structuredContent.grounding_repair.changed_payload_requires_new_idempotency_key, true)
  assert.equal(response.structuredContent.grounding_repair.unsupported_inference_destination, "unresolvedQuestions")
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

test("a protected-section draft rejection returns the shard to the same Drafter", async () => {
  const router = new HeadlessToolRouter({
    stagePageDrafts: async () => {
      throw new LlmWikiError("PAGE_DRAFT_SECTION_NOT_FULLY_VISIBLE", "The section was truncated.", {
        retryable: true,
        details: { heading: "Legacy Details", editable_section_headings: ["Recent Evidence"] },
      })
    },
  })
  const response = await router.callMcp("llm_wiki_stage_page_drafts", {
    task_id: "task-example",
    writer_id: "wiki-writer-1",
    projection_id: "projection-example",
    shard_id: "draft-0001",
    draft_claim_token: "claim-example",
    patches: [{ patchId: "patch-example" }],
    idempotency_key: "protected-section-v1",
  })
  assert.equal(response.isError, undefined)
  assert.equal(response.structuredContent.error.code, "PAGE_DRAFT_SECTION_NOT_FULLY_VISIBLE")
  assert.equal(response.structuredContent.atomic_commit_applied, false)
  assert.equal(response.structuredContent.page_commit_recovery.retry_scope, "redraft_entire_shard_using_only_new_or_fully_visible_sections")
  assert.deepEqual(response.structuredContent.next_action, {
    tool: "llm_wiki_stage_page_drafts",
    action_owner: "drafter",
    delegate_to: "llm-wiki-page-drafter",
    arguments: {
      task_id: "task-example",
      writer_id: "wiki-writer-1",
      projection_id: "projection-example",
      shard_id: "draft-0001",
      draft_claim_token: "claim-example",
    },
    required_generated_arguments: ["patches", "idempotency_key"],
  })
})

test("a retired staged merge schema routes the coordinator to a fresh manifest", async () => {
  const router = new HeadlessToolRouter({
    commitPages: async () => {
      throw new LlmWikiError("PAGE_DRAFT_SCHEMA_UPGRADE_REQUIRED", "The staged merge schema is retired.", {
        retryable: true,
        details: { projection_plan_invalidated: true, resume_view: "manifest" },
      })
    },
  })
  const response = await router.callMcp("llm_wiki_commit_pages", {
    task_id: "task-example",
    writer_id: "wiki-writer-1",
    projection_id: "projection-example",
    based_on_wiki_revision: "d".repeat(64),
    staged_draft_receipts: [{ shard_id: "draft-0001", draft_hash: "e".repeat(64) }],
    patches: [],
    idempotency_key: "schema-upgrade-v1",
  })
  assert.equal(response.isError, undefined)
  assert.equal(response.structuredContent.error.code, "PAGE_DRAFT_SCHEMA_UPGRADE_REQUIRED")
  assert.equal(response.structuredContent.page_commit_recovery.retry_scope, "refresh_manifest_and_redraft_retired_merge_payloads")
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

test("a fenced Drafter claim routes through a fresh manifest", async () => {
  const router = new HeadlessToolRouter({
    getPagePlanContext: async () => {
      throw new LlmWikiError("DRAFT_SHARD_CLAIM_FENCED", "The Drafter claim expired.", { retryable: true })
    },
  })
  const response = await router.callMcp("llm_wiki_get_page_plan_context", {
    task_id: "task-example",
    writer_id: "wiki-writer-1",
    projection_id: "projection-example",
    view: "draft-shard",
    shard_id: "draft-0007",
    draft_claim_token: "draft-claim-expired",
  })
  assert.equal(response.structuredContent.error.code, "DRAFT_SHARD_CLAIM_FENCED")
  assert.deepEqual(response.structuredContent.next_action, {
    tool: "llm_wiki_get_page_plan_context",
    action_owner: "coordinator",
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

test("publication ownership conflicts direct recovery to the owning task", async () => {
  const router = new HeadlessToolRouter({
    commitPages: async () => {
      throw new LlmWikiError("WIKI_PUBLICATION_BUSY", "Another task owns publication.", {
        retryable: true,
        details: { owner_task_id: "task-owner", atomic_commit_applied: false },
      })
    },
  })
  const response = await router.callMcp("llm_wiki_commit_pages", {
    task_id: "task-waiter",
    writer_id: "wiki-writer-1",
    projection_id: "projection-example",
    based_on_wiki_revision: "a".repeat(64),
    patches: [{ patchId: "patch-a" }],
    idempotency_key: "publication-owner-wait-v1",
  })
  assert.equal(response.structuredContent.error.code, "WIKI_PUBLICATION_BUSY")
  assert.equal(response.structuredContent.atomic_commit_applied, false)
  assert.equal(response.structuredContent.page_commit_recovery.retry_scope, "unchanged_patch_set_after_publication_owner_finishes_and_rebase")
  assert.deepEqual(response.structuredContent.next_action, {
    tool: "llm_wiki_status",
    arguments: { task_id: "task-owner" },
  })
  assert.equal(response.structuredContent.mcp_connection_usable, true)
})

test("premature Finalize routes directly to catch-up without asking for user confirmation", async () => {
  const nextAction = {
    tool: "llm_wiki_get_page_plan_context",
    action_owner: "coordinator",
    arguments: { task_id: "task-example", writer_id: "wiki-writer-1", view: "manifest", cursor: 0, max_chars: 40_000 },
  }
  const completionGate = {
    task_complete: false,
    may_report_completion: false,
    user_confirmation_required: false,
    automatic_continuation_required: true,
    next_action: nextAction,
  }
  const router = new HeadlessToolRouter({
    finalize: async () => {
      throw new LlmWikiError("FINALIZE_CATCHUP_REQUIRED", "One projection window remains.", {
        retryable: true,
        details: {
          unprojected_batch_count: 1,
          next_action: nextAction,
          completion_gate: completionGate,
        },
      })
    },
  })
  const response = await router.callMcp("llm_wiki_finalize", { task_id: "task-example" })
  assert.equal(response.structuredContent.error.code, "FINALIZE_CATCHUP_REQUIRED")
  assert.deepEqual(response.structuredContent.next_action, nextAction)
  assert.deepEqual(response.structuredContent.completion_gate, completionGate)
  assert.equal(response.structuredContent.completion_gate.user_confirmation_required, false)
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
    renewLease: failing,
    retrieveContext: failing,
    queryDomainPages: failing,
    commitAnalysis: failing,
    getPagePlanContext: failing,
    stagePageDrafts: failing,
    getStagedPageDrafts: failing,
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
