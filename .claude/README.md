# Claude Code integration

The project root `.mcp.json` starts the Headless `llm-wiki` STDIO MCP server.
It resolves the executable and workspace from `CLAUDE_PROJECT_DIR` and marks
the small 12-tool server as `alwaysLoad`, so changing the shell working
directory or deferred tool discovery cannot detach the workflow. Claude Code
asks for project-server trust the first time it reads this file.

`.claude/settings.json` approves the project `llm-wiki` server, every tool from
that server, the builder Skill, all subagents, and read-only repository tools.
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
prompted, and confirm `/mcp` reports `Connected` with 12 tools. Attach or
reference documents, then ask:

```text
把这些文档构建成 llm_wiki 知识库。
```

For imports with multiple batches, the Skill first runs one non-leasing MCP
capability probe, then starts up to four background `llm-wiki-extractor` agents
using distinct worker leases. Each extractor invocation processes one batch,
persists it, and exits; the coordinator then starts the next short invocation
in that slot. This avoids depending on one long-lived subagent across user
turns. Each project agent explicitly reuses the parent
`llm-wiki` MCP connection and uses a denylist for shell, writes, network, and
nested agents; it does not use a fragile MCP wildcard as its complete tool
allowlist. The agent runs in `dontAsk` mode. One
`llm-wiki-writer` agent consumes leased micro-batch projections after four new
batches or a 30-second debounce, while later extraction continues. Incremental
pages remain provisional and excluded from retrieval until the writer completes
the final all-batch reconciliation. The main Agent remains responsive for
questions: retrieval defaults to BM25 + embedding while the task is building,
then adds the Wiki channel automatically after Finalize.

An extractor stops and reports `writer_required: true` as soon as its accepted
commit makes a projection ready. The coordinator starts `wiki-writer-1` before
replacing that extractor. Page-plan calls use 40K-character pages and include
only domain Schema identity metadata, so a multi-megabyte extraction Schema is
never copied into the Wiki writer's tool response.

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

If the probe reports `mcp_ready: false`, the Skill does not retry with a
`general-purpose` agent. It continues in the coordinator, because changing the
agent name cannot repair an MCP server that was not inherited by subagents.
After pulling this configuration change, fully restart Claude Code so existing
subagent definitions are not reused from the prior session.

You may also explicitly invoke the workflow with `/llm-wiki-builder`.
