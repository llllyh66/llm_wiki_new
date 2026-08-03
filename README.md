# llm_wiki

[Chinese usage guide / 中文使用说明](README.zh-CN.md)

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

If `llm-wiki.domain-schema.json` exists at the workspace root, imports also
snapshot and enforce it as the entity/property/relation extraction contract.
You can instead pass `options.domain_schema_path` or `options.domain_schema` to
`llm_wiki_import_files`. Compatible mode resolves names and aliases to stable
IDs; `drop-invalid` safely removes nonconforming candidates and reports them in
`domain_validation`, while `reject-batch` returns a recoverable
`INVALID_DOMAIN_ANALYSIS` result.

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
- `llm_wiki_get_domain_schema`
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

The Claude Code registration uses `CLAUDE_PROJECT_DIR` rather than a mutable
shell working directory and keeps this bounded 12-tool server loaded for the
session. MCP input/output budgets and paginated page-plan context prevent a
single oversized request or response from closing the STDIO transport.
Every tool exception is returned as a normal result (`ok: false`,
`accepted: false`, `error`, `next_action`, and `mcp_connection_usable: true`)
instead of entering MCP's `isError` channel.

Large tables, code blocks, and legacy oversized chunks are split before
`get_batch`. Batches are bounded by both text and serialized payload size and
are always returned complete; `batch_limits` reports the actual size. Set
`options.max_batch_chars` during import to request smaller batches.
Domain Schemas up to 5 MiB are accepted. Schemas larger than 64 KiB are
summarized in batch and page-plan responses and exposed through bounded
`llm_wiki_get_domain_schema` pages.

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
llm-wiki.domain-schema.json # optional domain extraction contract
```

Sources are content-addressed and deduplicated. Task, batch, analysis,
idempotency, transaction, and final result state survive Agent session restarts.

## Supported formats

- Markdown and UTF-8 text
- HTML, including normalized tables
- DOCX, including table rows, headers, column spans, and vertical merge metadata
- XLSX workbooks, including sheet names, A1 ranges, cached formula results,
  merged cells, hidden rows/columns, and date normalization
- PDF text layers with page-number SourceRef locators

DOCX macros and embedded objects are never executed. XLSX formulas are never
evaluated, macros and external links are ignored, and only stored cell values
are imported. Legacy `.xls` files must first be saved as `.xlsx`. PDF parsing
disables dynamic evaluation and does not launch an external viewer. Scanned PDF
OCR is a future parser adapter and is not silently treated as trustworthy text.

## Retrieval and writing safety

Retrieval recalls source chunks, committed analysis, and Wiki sections through
BM25, configurable real embeddings, and Wiki title/path/link-graph ranking,
then combines the independent rankings with reciprocal-rank fusion (RRF).
Corpora and responses have explicit limits; results report truncation and each
channel's status. Embedding requests are batched, timed out, cached by content
hash in sharded files, and automatically degrade to the local feature-hash
fallback without failing BM25 or Wiki recall.

Embedding is disabled by default. Configure an OpenAI-compatible endpoint at
runtime without saving its API key in the repository:

```bash
export LLM_WIKI_EMBEDDING_PROVIDER=openai-compatible
export LLM_WIKI_EMBEDDING_MODEL=your-embedding-model
export LLM_WIKI_EMBEDDING_URL=http://127.0.0.1:8000/v1/embeddings
export LLM_WIKI_EMBEDDING_API_KEY=your-runtime-key # omit when not required
```

For Ollama, use `LLM_WIKI_EMBEDDING_PROVIDER=ollama` and set the model; the
default endpoint is `http://127.0.0.1:11434/api/embed`. Persistent, non-secret
tuning is available under `retrieval` in `.llm-wiki/config.json`, including
`maxDocuments`, `rrfK`, and embedding `batchSize`, `timeoutMs`,
`totalTimeoutMs`, `maxInputChars`, and `maxDocuments`.

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
npm run cli -- import ./document.md --domain-schema ./schemas/domain.json --workspace .
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
