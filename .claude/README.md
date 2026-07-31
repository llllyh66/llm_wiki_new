# Claude Code integration

The project root `.mcp.json` starts the Headless `llm-wiki` STDIO MCP server.
Claude Code asks for project-server trust the first time it reads this file.

`.claude/skills/llm-wiki-builder` is a relative symbolic link to the canonical
`.agents/skills/llm-wiki-builder` directory. This lets Claude Code discover the
project Skill while Codex and other Agent Skills clients use the same source.
Do not replace the link with a copied Skill.

Verify from the repository root:

```bash
npm ci
npm run build
claude mcp list
```

Expected MCP status:

```text
llm-wiki: node packages/mcp-server/dist/index.js --workspace . - Connected
```

Start Claude Code from the repository root, approve the project MCP server if
prompted, attach or reference documents, then ask:

```text
把这些文档构建成 llm_wiki 知识库。
```

You may also explicitly invoke the workflow with `/llm-wiki-builder`.
