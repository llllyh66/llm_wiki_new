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

For imports with multiple batches, the Skill starts up to four background
`llm-wiki-extractor` agents using distinct worker leases. That project agent is
restricted to Read and `llm-wiki` MCP tools and runs in `dontAsk` mode. One
`llm-wiki-writer` agent consumes leased micro-batch projections after four new
batches or a 30-second debounce, while later extraction continues. Incremental
pages remain provisional and excluded from retrieval until the writer completes
the final all-batch reconciliation. The main Agent remains responsive for
questions: retrieval defaults to BM25 + embedding while the task is building,
then adds the Wiki channel automatically after Finalize.

You may also explicitly invoke the workflow with `/llm-wiki-builder`.
