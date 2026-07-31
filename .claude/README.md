# Claude Code integration

The project root `.mcp.json` starts the Headless `llm-wiki` STDIO MCP server.
It resolves the executable and workspace from `CLAUDE_PROJECT_DIR` and marks
the small 11-tool server as `alwaysLoad`, so changing the shell working
directory or deferred tool discovery cannot detach the workflow. Claude Code
asks for project-server trust the first time it reads this file.

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
prompted, and confirm `/mcp` reports `Connected` with 11 tools. Attach or
reference documents, then ask:

```text
把这些文档构建成 llm_wiki 知识库。
```

You may also explicitly invoke the workflow with `/llm-wiki-builder`.
