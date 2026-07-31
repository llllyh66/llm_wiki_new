# llm_wiki

`llm_wiki` is a headless, Agent-first local knowledge-base engine. The current
Codex, OpenCode, or Claude Code model understands your documents; a model-free
Core manages source files, tasks, validation, transactions, retrieval, indexes,
and the generated `wiki/`.

## Build a knowledge base with your Agent

1. Install and build once:

   ```bash
   npm install
   npm run build
   ```

2. Open this workspace in Codex, OpenCode, or Claude Code and enable the
   project MCP configuration.
3. Drag one or more documents into the Agent conversation.
4. Ask:

   ```text
   Build an llm_wiki knowledge base from these documents.
   ```

The Agent automatically imports the attachments, initializes the local
workspace, extracts knowledge, writes Wiki pages, updates indexes, and reports
the result.

No desktop application, separate HTTP server, project creation, Provider API
key, or `raw/sources/` directory is required.

For Claude Code, run `claude` from the repository root. The checked-in
`.mcp.json` registers the server, and `.claude/skills/llm-wiki-builder` links to
the canonical shared Skill. Approve the project MCP server on first use.

## Architecture

```text
Codex / OpenCode / Claude Code current model
  -> .agents/skills/llm-wiki-builder/SKILL.md
  -> llm-wiki MCP over STDIO
  -> packages/core (no model, UI, Tauri, or HTTP dependency)
  -> wiki/ and .llm-wiki/ in the current workspace
```

The host Agent owns semantic analysis, canonical page planning, contradiction
resolution, and prose generation. The Core owns deterministic operations and
never launches a model, `codex`, `claude`, or arbitrary shell command.

## MCP tools

- `llm_wiki_import_files`
- `llm_wiki_get_batch`
- `llm_wiki_retrieve_context`
- `llm_wiki_commit_analysis`
- `llm_wiki_get_page_plan_context`
- `llm_wiki_commit_pages`
- `llm_wiki_finalize`
- `llm_wiki_status`
- `llm_wiki_list_tasks`
- `llm_wiki_abort`
- `llm_wiki_lint`

The server is restricted to the workspace supplied at process startup. Tools do
not accept an arbitrary workspace or project path. The only external paths it
opens are files explicitly passed to `llm_wiki_import_files`; after a safe,
streaming import, all later work uses the managed copy.

## Managed workspace

The first import creates:

```text
wiki/
.llm-wiki/
  workspace.json
  config.json
  sources/objects/<sha256>/
  sources/manifests/
  tasks/
  indexes/
  locks/
  journal/
llm-wiki.schema.md
```

Sources are content-addressed and deduplicated. Task, batch, analysis,
idempotency, transaction, and final result state survive Agent session restarts.

## Supported formats

- Markdown and UTF-8 text
- HTML, including normalized tables
- DOCX, including table rows, headers, column spans, and vertical merge metadata
- PDF text layers with page-number SourceRef locators

DOCX macros and embedded objects are never executed. PDF parsing disables
dynamic evaluation and does not launch an external viewer. Scanned PDF OCR is a
future parser adapter and is not silently treated as trustworthy text.

## Retrieval and writing safety

Retrieval uses BM25, deterministic feature-hash vector cosine similarity, graph
neighbors, and reciprocal-rank fusion. Channels are local and model-free.

Agent page writes are limited to `wiki/sources/`, `wiki/entities/`,
`wiki/concepts/`, `wiki/topics/`, and `wiki/comparisons/`. Each patch is checked
for:

- normalized safe path and symbolic-link escape;
- valid task-owned SourceRefs and bounded matching quotes;
- page schema and payload limits;
- expected file hash and Wiki revision;
- whole-batch staging, rollback, journal, and workspace locking.

`wiki/index.md`, `wiki/overview.md`, and `wiki/log.md` are maintained only by
Finalize.

## CLI

The CLI is for initialization, preprocessing, CI, status, lint, and recovery. It
does not perform semantic extraction:

```bash
npm run cli -- init --workspace .
npm run cli -- import ./document.md --workspace .
npm run cli -- status <task-id> --workspace .
npm run cli -- lint --workspace .
npm run cli -- abort <task-id> --workspace .
npm run cli -- migrate-legacy raw/sources --workspace .
```

`migrate-legacy` is an explicit, one-time bridge for an existing desktop-era
source tree. It imports supported files into content-addressed managed storage
and creates a normal Agent task; the new runtime never watches or depends on the
legacy directory.

## Development

```bash
npm install
npm run build
npm test
```

Tests use fixed AnalysisEnvelope and PagePatch fixtures. They do not call a real
model or require a desktop/HTTP process. See
[`plans/agent-first-refactor-progress.md`](plans/agent-first-refactor-progress.md)
for the audit, phase status, test evidence, and remaining migration work.
