# Claude Code integration

The project root `.mcp.json` starts the Headless `llm-wiki` STDIO MCP server.
It resolves the executable and workspace from `CLAUDE_PROJECT_DIR` and marks
the small 13-tool server as `alwaysLoad`, so changing the shell working
directory or deferred tool discovery cannot detach the workflow. Claude Code
asks for project-server trust the first time it reads this file.

`.claude/settings.json` approves the project `llm-wiki` server, every tool from
that server (both server-wide and all 13 explicit tool names), the builder
Skill, the named extractor/writer Agents, ToolSearch, all subagents, and
read-only repository tools.
It uses `dontAsk`, so background agents never pause for permission: tools not
needed by the extraction workflow are denied instead of prompting. It does not
grant blanket Bash, arbitrary file-write, network, or bypass-permissions access
to untrusted document content.

`.claude/skills/llm-wiki-builder/SKILL.md` is a regular, discoverable Claude
Code entrypoint that directs Claude to the canonical
`.agents/skills/llm-wiki-builder/SKILL.md`. The workflow remains single-source
without relying on directory symlink discovery, which is not consistent across
Claude Code versions and cloned worktrees.

Verify from the repository root:

```bash
npm ci
npm run build
claude mcp list
test -f .claude/skills/llm-wiki-builder/SKILL.md
```

Expected MCP status:

```text
llm-wiki: node packages/mcp-server/dist/index.js --workspace . - Connected
```

Start Claude Code from the repository root, approve the project MCP server if
prompted, and confirm `/mcp` reports `Connected` with 13 tools. Attach or
reference documents, then ask:

```text
把这些文档构建成 llm_wiki 知识库。
```

For imports with multiple batches, the coordinator verifies the imported task
with one direct `llm_wiki_status` call, then starts up to four background
`llm-wiki-extractor` agents using distinct worker leases. It does not create a
throwaway probe Agent or manage a Team. Each extractor invocation processes a
bounded quantum of up to three batches and persists every batch independently;
the coordinator then starts the next bounded invocation in that slot. This
reduces repeated Agent startup and Skill-loading overhead without depending on
one long-lived subagent across user turns. Each project agent explicitly reuses the parent
`llm-wiki` MCP connection and uses a denylist for shell, writes, network, and
nested agents; it does not use a fragile MCP wildcard as its complete tool
allowlist. The agent runs in `dontAsk` mode. One
`llm-wiki-writer` agent calls the deterministic fast projection tool after four
new batches or a 30-second debounce, while later extraction continues. A fast
projection consumes up to 32 batches and one Writer invocation drains up to six
ready projections without per-page Agent drafting, page-plan pagination, an
intermediate status call, or cooldown. Incremental
pages remain provisional and excluded from retrieval until the writer completes
the final all-batch reconciliation. The main Agent remains responsive for
questions: retrieval defaults to BM25 + embedding while the task is building,
then adds the Wiki channel automatically after Finalize.
Incremental pages are concise grounded drafts. Completed extraction drains any
remaining incremental backlog before final mode; when explicit page coverage
is complete and unique with no contradictions, Core recommends an empty final
stabilization commit instead of regenerating the entire Wiki.

Every initial and replacement slot must use the exact project Agent type
`llm-wiki-extractor`; a generic "Worker N", `general-purpose` Agent, or Team
teammate does not apply that file's `mcpServers` field. The MCP server and all
13 tools are marked always-load, with ToolSearch as a deferred-discovery
fallback. Claude Code 2.1.121 or later is recommended because that release adds
the documented `alwaysLoad` behavior; fully restart Claude Code after updating.

The extraction hot path does not invoke retrieval for every batch. `get_batch`
automatically includes bounded domain-Schema definitions matched from canonical
labels in the source text, and the worker analyzes the complete leased evidence
directly. Schema search and BM25/embedding retrieval are reserved for genuine
classification or cross-batch ambiguity. User questions still use the normal
multi-route retrieval defaults.

An extractor stops and reports `writer_required: true` as soon as its accepted
commit makes a projection ready. The coordinator starts `wiki-writer-1` before
replacing that extractor. The default `llm_wiki_apply_projection` call renders
only facts already validated during extraction and commits them in bounded
transactions. Legacy page-plan calls use 40K-character pages and include
only domain Schema identity metadata, so a multi-megabyte extraction Schema is
never copied into the Wiki writer's tool response.
Legacy incremental page plans include full text only for pages affected by the current
projection. Unrelated pages are represented by compact catalog entries, so
Writer cost no longer grows with the total byte size of the existing Wiki.
The Writer must collect every sequential page-plan cursor before its first
commit. Core persists a stable projection snapshot and rejects premature
commits with the exact next cursor, preventing provisional pages hidden on a
later cursor from being recreated without their current hashes.

At the beginning of a later user turn, the coordinator calls
`llm_wiki_status`. Its `worker_recovery.leases` list contains each persisted
worker ID and batch. Relaunching the extractor with that same ID returns the
same lease through a fresh MCP client connection, so losing an old background
Agent does not lose task state and is not evidence that MCP disconnected. A
successful status call proves MCP is usable in the current turn; do not ask the
user to run `/mcp` unless an actual transport call fails.

`worker_recovery.leases` describes persisted batch reservations, not live
SubAgent processes. The coordinator tracks live invocations separately. When
one extractor reports completion, its slot is refilled immediately: if its ID
still owns a lease, the same ID resumes that batch; otherwise it requests the
next available batch. It never waits for a different extractor merely because
both reservations were present before the completion notification.

If a worker's concrete MCP call reports `mcp_ready: false`, the Skill does not
retry with a `general-purpose` agent. It continues in the coordinator, because
changing the agent name cannot repair an MCP server that was not inherited by
subagents. A Team initialization warning is not an MCP probe result. When the
host confirms workers were launched, the coordinator tracks those workers and
does not duplicate their work locally.
After pulling this configuration change, fully restart Claude Code so existing
subagent definitions are not reused from the prior session.

You may also explicitly invoke the workflow with `/llm-wiki-builder`.
