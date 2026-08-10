# CAC-compatible integration

This directory targets CAC clients that implement Claude Code-compatible
project settings, hooks, agents, skills, and the `CAC_PROJECT_DIR` placeholder.
The project root `.mcp.json` connects such a client to the Headless `llm-wiki`
Streamable HTTP MCP server on loopback. A `SessionStart` command hook resolves
the executable and workspace from `CAC_PROJECT_DIR` using CAC's
cross-platform exec form, then idempotently starts
a detached project-local supervisor. The supervisor restarts a crashed worker
with exponential backoff. When the client supports HTTP MCP reconnect and
`anthropic/alwaysLoad`, the small 17-tool server remains available across
worker restarts, so changing the
shell working directory or deferred tool discovery cannot detach the workflow.
The client may ask for project-server and hook trust the first time it reads the
checked-in configuration.

On native Windows, both detached Node processes use hidden-window spawning, so
the daemon does not leave an empty `node.exe` console window open.

`.cac/settings.json` approves the project `llm-wiki` server, every tool from
that server (both server-wide and all 17 explicit tool names), the builder
Skill, the named extractor/writer Agents, ToolSearch, all subagents, and
read-only repository tools.
It uses `dontAsk`, so background agents never pause for permission: tools not
needed by the extraction workflow are denied instead of prompting. It does not
grant blanket Bash, arbitrary file-write, network, or bypass-permissions access
to untrusted document content.

`.cac/skills/llm-wiki-builder/SKILL.md` is a regular, discoverable CAC
Code entrypoint that directs CAC to the canonical
`.agents/skills/llm-wiki-builder/SKILL.md`. The workflow remains single-source
without relying on directory symlink discovery, which is not consistent across
CAC Code versions and cloned worktrees.

Verify from the repository root:

```bash
npm ci
npm run build
# Use your CAC client's MCP status page or actual launcher command.
test -f .cac/skills/llm-wiki-builder/SKILL.md
```

Expected MCP status:

```text
llm-wiki: http://127.0.0.1:31982/mcp (HTTP) - Connected
```

Open the repository root in the CAC client, approve the project MCP server if
prompted, and confirm `/mcp` reports `Connected` with 17 tools. Attach or
reference documents, then ask:

```text
把这些文档构建成 llm_wiki 知识库。
```

For imports with multiple batches, the coordinator verifies the imported task
with one direct `llm_wiki_status` call, then starts up to four background
`llm-wiki-extractor` agents using distinct worker leases. It does not create a
throwaway probe Agent or manage a Team. Each extractor invocation processes a
bounded quantum of up to six batches and persists every batch independently;
the coordinator then starts the next bounded invocation in that slot. This
reduces repeated Agent startup and Skill-loading overhead without depending on
one long-lived subagent across user turns. Each project agent explicitly reuses the parent
`llm-wiki` MCP connection and uses a denylist for shell, writes, network, and
nested agents; it does not use a fragile MCP wildcard as its complete tool
allowlist. The agent runs in `dontAsk` mode. After four new batches or a
30-second debounce, the main coordinator fetches a compact page manifest and
launches path-disjoint `llm-wiki-page-drafter` agents. Each Drafter reads one
bounded shard and stages it server-side. Only after a receipt exists does the
coordinator launch `llm-wiki-writer`, which commits hash-bound receipts without reading
page bodies. Incremental pages remain provisional and excluded from retrieval
until final all-batch reconciliation. The main Agent remains responsive for
questions: retrieval defaults to BM25 + embedding while the task is building,
then adds the Wiki channel automatically after Finalize.
Incremental pages are concise grounded drafts. Completed extraction drains any
remaining incremental backlog before final mode. Final mode always performs
semantic reconciliation over the persisted shard manifest, even when coverage
is already complete and unique.

Every initial and replacement slot must use the exact project Agent type
`llm-wiki-extractor`; a generic "Worker N", `general-purpose` Agent, or Team
teammate does not apply that file's `mcpServers` field. The MCP server and all
17 tools are marked always-load, with ToolSearch as a deferred-discovery
fallback. Confirm your CAC client documents `alwaysLoad`, HTTP reconnect, the
project hook schema, and `CAC_PROJECT_DIR`; these capabilities cannot be
inferred from the `.cac` directory name alone. Fully restart the client after
updating. Each device starts its own daemon. If port 31982 is already in use on
one device, set `LLM_WIKI_MCP_HTTP_PORT` before starting the client; the
same variable is expanded by both `.mcp.json` and the startup hook.
After `npm run build`, the next `SessionStart` compares `dist/build-info.json`
with `/health` and replaces an older daemon before the client reconnects.

The server enforces a total four-Agent pipeline budget (normally two
extractors plus two page drafters while extraction overlaps), and its router
returns `MCP_BUSY`/`TASK_BUSY` rather than allowing unbounded tool queues. For
long runs, inspect `.llm-wiki/logs/mcp-runtime.jsonl` after a real transport
error; it records build, memory, request, heartbeat, and shutdown events.
Supervisor lifecycle and crash-restart events are written to
`.llm-wiki/logs/mcp-daemon.log`.

The extraction hot path does not invoke retrieval for every batch. `get_batch`
returns only the immutable progressive Domain Schema snapshot identity and
disclosure instructions. The worker explicitly reads `domains`, each selected
Domain, and each selected complete ABE JSON before choosing a BE. It copies the
ABE response's `classification_scaffold` and `be_pointer_hints`; Core
canonicalizes the reference and derives non-empty BE metadata from the selected
Schema node. BM25/embedding
retrieval is reserved for genuine cross-batch ambiguity. User questions still
use the normal multi-route retrieval defaults.

An extractor stops and reports `writer_required: true` as soon as its accepted
commit makes a projection ready. The coordinator starts manifest/Drafter
orchestration and immediately refills the same extractor ID in parallel when
`worker_restart.required` is true and the overlap cap has room; it does not start
`wiki-writer-1` until a Drafter receipt exists. The default
`llm_wiki_get_page_plan_context` manifest call returns a compact server-side draft manifest;
it never renders or writes pages automatically. Each coordinator-launched
Drafter fetches one at-most-six-path shard and stages a receipt. The Writer
commits one ready receipt wave, returns any coordinator-owned next action, and
stops. The manifest states the hard 50-patch limit before generation, so an
oversized result is never generated and then repeated. Full affected page
content and hashes appear only in their matching shard. The Writer never
launches Drafters and never fetches manifest/draft-shard context in normal
mode. Serial Writer drafting is permitted only after a concrete Drafter
creation failure and an explicit `explicit-serial-writer-fallback-only`
handoff. This keeps large final reconciliation out of model context and lets
recovery resume at the first uncovered shard after context compaction.

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
After pulling this configuration change, fully restart the CAC client so existing
subagent definitions are not reused from the prior session.

You may also explicitly invoke the workflow with `/llm-wiki-builder`.
