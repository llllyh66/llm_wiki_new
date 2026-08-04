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
IDs. Extraction is Schema-first: invalid candidates are rejected before
persistence even when the Schema says `drop-invalid`. Destructive dropping is
available only through the explicit `accept_dropped_candidates` commit option;
`reject-batch` always returns a recoverable `INVALID_DOMAIN_ANALYSIS` result.
`relationTypes` may be an empty array; this disables domain-level relation
constraints and keeps general relation extraction enabled. `entityTypes` must
still contain at least one type.

No desktop application, separate HTTP server, project creation, Provider API
key, or `raw/sources/` directory is required.

For Claude Code, run `claude` from the repository root. The checked-in
`.mcp.json` registers the server, and `.claude/skills/llm-wiki-builder` links to
the canonical shared Skill. The checked-in `.claude/settings.json` pre-approves
all `llm-wiki` MCP tools for the main and background agents and uses `dontAsk`
for unattended extraction. Unrelated shell, write, and network tools remain
unapproved. Approve project trust on first use, then restart Claude Code after
changing these files.

Every initial and replacement extraction slot explicitly uses the named project
Agent type `llm-wiki-extractor`. Generic "Worker N", `general-purpose`, and
Agent Team teammates are not used because they do not apply that Agent file's
`mcpServers` declaration. Permissions list all 13 MCP tools explicitly, every
published tool carries `anthropic/alwaysLoad`, and ToolSearch provides a
deferred-discovery fallback. Claude Code 2.1.121 or later is recommended for
the documented always-load behavior.

For multi-batch imports, the Skill starts the Core-recommended number of
background extraction agents (up to four). Stable worker leases keep batches
distinct and task-level serialization prevents concurrent commits from losing
state. The coordinator verifies MCP with one direct task-status call; it does
not create a throwaway probe Agent or a Team. A worker's first batch call checks
its inherited MCP capability. Team lifecycle warnings are never treated as MCP
success or failure, and successfully launched workers are not duplicated by
coordinator extraction. When a commit makes a Wiki projection
ready, that extractor returns immediately with `writer_required: true` so the
coordinator starts `wiki-writer-1` before leasing more work. Page-plan responses
never include the full extraction Schema and default to roughly 40K-character
pages, even when the task Schema is several MiB. The main Agent remains available for questions and coordinates page
generation through exactly one background Wiki writer. After four new batches,
or after a 30-second debounce, that writer incrementally updates affected
pages while extractors continue. Each projection is capped at eight batches;
one Writer invocation drains up to six ready projections (48 batches) immediately when a
backlog exists. Incremental plans include full content only for affected pages
and compact catalog metadata for unrelated pages. A final all-batch reconciliation stabilizes
the pages before Finalize.
Writers collect every page-plan cursor from a stable server-side snapshot
before committing. The Core rejects premature commits with the exact next
cursor, so later-page provisional hashes cannot be missed or guessed.
Incremental pages use concise grounded drafts. When extraction finishes, Core
first drains any remaining bounded projections instead of creating one giant
all-batch final prompt. If all requirements then have unique explicit coverage
and no contradiction exists, final reconciliation becomes a verified empty
stabilization commit rather than a full page rewrite.

Each extractor invocation handles a bounded quantum of up to six batches,
persisting an independent checkpoint after every batch. This amortizes Agent
startup and Skill-loading time while preserving recovery. On a later turn,
`llm_wiki_status` exposes
`worker_recovery.leases`; relaunching a short-lived extractor with the same
`worker_id` resumes the same batch using a fresh MCP client connection. The
workflow therefore does not depend on background Agent or MCP-client lifetime
across turns, and it does not infer a disconnect when a successful status call
shows the current connection is usable.

Page planning restores the original rich-Wiki behavior without restoring the
desktop runtime. Every important extracted entity, concept, and explicit page
candidate becomes a paginated `page_requirement`; a projection cannot complete
until canonical pages cover all requirements. The Core normalizes full page
frontmatter, preserves summaries, tags, and source coverage, creates
bidirectional Related navigation, writes rich source summaries, and rebuilds
grouped index and knowledge-map overview pages. Expanded page types include
research, business, reading, and personal-knowledge variants such as query,
synthesis, finding, methodology, thesis, project, decision, chapter,
character, theme, plot-thread, reflection, and journal.

## Architecture

```text
Codex / OpenCode / Claude Code current model
  -> .agents/skills/llm-wiki-builder/SKILL.md
  -> llm-wiki MCP over STDIO
  -> packages/core (no model, UI, Tauri, or HTTP dependency)
  -> wiki/ and .llm-wiki/ in the current workspace
```

The host Agent owns semantic extraction and contradiction resolution. The Core
owns deterministic validation, canonical projection of those validated facts,
transactions, and indexes; it never launches a model, `codex`, `claude`, or an
arbitrary shell command. Legacy Agent-authored page planning remains available
for custom prose workflows, but is no longer on the default ingestion path.

## MCP tools

- `llm_wiki_import_files`
- `llm_wiki_get_batch`
- `llm_wiki_get_domain_schema`
- `llm_wiki_retrieve_context`
- `llm_wiki_commit_analysis`
- `llm_wiki_apply_projection` (fast default Writer path)
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
shell working directory and keeps this bounded 13-tool server loaded for the
session. MCP input/output budgets and paginated page-plan context prevent a
single oversized request or response from closing the STDIO transport.
Every tool exception is returned as a normal result (`ok: false`,
`accepted: false`, `error`, `next_action`, and `mcp_connection_usable: true`)
instead of entering MCP's `isError` channel.

Large tables, code blocks, and legacy oversized chunks are split before
`get_batch`. Batches are bounded by both text and serialized payload size and
are always returned complete; `batch_limits` reports the actual size. Set
`options.max_batch_chars` during import to request smaller batches. Extractors
pass the server's `recommended_batch_chars` to `get_batch`: 6,000 for small
tasks and 9,000 for large tasks. Repartitioning never truncates content and
preserves each original batch ID and reservation on its first repaired part.
Agent transport ceilings remain fixed at 3,000 characters per chunk, at most
9,000 source characters per batch, and 24 KiB of serialized chunk payload even
when an old workspace requested larger values.
The full `get_batch` result is also budgeted: the unrelated Wiki page schema is
omitted, the Analysis schema is represented by a compact contract, and a large
domain Schema contributes only a compact batch-matched slice. `batch_limits`
reports chunk-payload bytes and complete-response bytes against a 40 KiB target.
Oversized structured table fields are compacted so pretty-printed MCP JSON does
not contain an unreadable 80K single line. An unfinished legacy batch is
repaired in place while preserving its original batch ID and worker lease.
One chunk is bounded by the smaller of the chunk and batch limits, so legacy
repair does not repeatedly rebuild the same batch or invalidate worker leases.
Domain Schemas up to 5 MiB are accepted. Schemas larger than 8 KiB are
summarized on the extraction hot path so the complete batch response remains
bounded. Extractors use server-side
`llm_wiki_get_domain_schema` search to receive only the complete definitions
and properties matched to the current batch. Bounded catalog and exact-type
modes resolve ambiguous classifications without reconstructing the full Schema
in Agent context; Core validation still enforces the complete task snapshot.
Every batch also includes a ready-to-fill `analysis_scaffold` and a
server-generated `evidence_catalog`. Workers cite zero-based evidence indexes;
they no longer transcribe quotes, reread source files, or reconstruct spreadsheet
sheet names and cell ranges. Core resolves the indexes and persists only the
complete SourceRefs actually used. Legacy complete SourceRefs remain compatible,
and minor Markdown/Unicode quote differences are canonicalized only when they
match one unique source span.
For large Schemas, `get_batch` now performs deterministic batch-text matching
against canonical type IDs, names, aliases, and property labels and embeds the
bounded complete definitions directly. Most batches therefore need no separate
Schema call. Extraction also skips BM25/embedding retrieval by default because
the leased batch is complete evidence and final projection reconciles batches;
retrieval remains available for explicit cross-batch ambiguity and remains the
default multi-route path for user questions.

Large-task storage and coordination are also bounded. Task batches retain only
the table locator metadata needed for extraction instead of duplicating complete
structured tables. Verified batch bounds and parsed `batches.json` files are
cached across a worker quantum. Large-Schema selection uses one cached
multi-pattern matcher instead of scanning every type, property, and alias for
every batch. Idempotency results are stored in per-key shards, avoiding repeated
rewrites of one ever-growing JSON file. A short cross-process task lock protects
leases and commits when independent MCP clients work on the same task, while
semantic analysis remains outside the lock and can still run in parallel.

Incremental page projection is single-writer and lease-based. Intermediate
paths are persisted as provisional task state and excluded from retrieval
across every active task. Large projections may use several commits of at most
50 patches each; the lease is released only by the final commit. Backlogs
bypass the normal cooldown while at least four unprojected batches remain, but
each projection stays bounded and independently checkpointed. Finalize is
blocked until one full reconciliation clears all provisional paths.
Different tasks may run one Writer each. Core serializes their workspace write
transactions and validates only the exact target page paths and hashes, so an
unrelated page commit no longer invalidates another Writer's paginated plan.
Each page requirement includes a ready-to-fill patch scaffold. Its SourceRefs
are requirement IDs which Core resolves to the exact persisted quotes and
locators, eliminating quote transcription during page generation. Legacy full
SourceRefs are still accepted and uniquely safe Markdown, Unicode-quote, and
whitespace differences are repaired before validation. Later page-plan cursors
reuse the persisted snapshot instead of rebuilding analyses and rereading every
Wiki page. Tools which do not consume a Wiki revision also skip the full Wiki
hash, and a newly launched Writer follows the coordinator's current action
without an extra status probe.

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
While a task is building, the default channels are BM25 + embedding so the
main Agent can answer early questions without waiting for page generation.
After Finalize, the same call automatically enables BM25 + embedding + Wiki.
The response exposes this as `retrieval_phase`.
Stable Wiki pages from earlier completed work remain searchable during a new
build, but pages produced by an incomplete projection are excluded.
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
