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

If `llm-wiki.domain-schema/` exists at the workspace root, imports snapshot and
enforce it as the progressive Domain Schema. You can instead pass
`options.domain_schema_path` to `llm_wiki_import_files`. Inline and single-file
Schemas are not supported.

The Schema directory has this layout:

```text
schemas/customer/
├── all_domains.json
├── customer/
│   ├── customer_domain.json
│   └── customer_management.json
└── product/
    ├── product_domain.json
    └── product_design.json
```

The JSON contents are intentionally unrestricted beyond valid JSON. The Agent
reads the complete `all_domains.json`, then the selected Domain's
`*_domain.json`, then the complete selected ABE JSON before choosing a BE.
`llm_wiki_get_domain_schema` accepts `level=domains`, `level=domain` with
`domain_folder`, and `level=abe` with `domain_folder` plus `abe_file`.
The ABE response includes a canonical `classification_scaffold` and bounded
`be_pointer_hints`; workers copy those values instead of reconstructing file
names or guessing pointers. Entities and concepts carry `schemaClassification`
with a JSON Pointer into the selected ABE file. Core accepts `/...` and `#/...`,
canonicalizes unique Domain/ABE/BE references, derives BE key/name from the
pointed Schema node, and verifies the immutable snapshot, file chain and hashes.
Semantic classification remains the model's responsibility.
Ambiguous candidates are retained with `status: "unresolved"`. Wiki pages show
the resulting Domain → ABE → BE path and index its keys and names. A disclosed
JSON file is read and returned verbatim (up to the 5 MiB per-file safety
ceiling); a complete snapshot is limited to 20 MiB. Oversized files fail import
rather than being truncated.

Classified Wiki pages are projected from the validated task Schema. Entity and
concept pages receive the snapshot identity, classification status, Domain,
ABE, BE, and complete path in frontmatter, plus a generated Domain
Classification section. Core derives these fields from covered page
requirements, so a Writer cannot invent or silently omit a classification.
Existing pages can be backfilled by calling `llm_wiki_finalize` with
`refresh_page_metadata: true`.

No desktop application, manually managed service, project creation, Provider
API key, or `raw/sources/` directory is required.

For Claude Code, run `claude` from the repository root. The checked-in
`.mcp.json` registers a loopback Streamable HTTP endpoint. A checked-in
`SessionStart` hook idempotently starts a project-local supervisor, which
restarts the MCP worker with exponential backoff after a crash. Claude Code
2.1.121 or later then supplies native HTTP reconnect with exponential backoff.
This setup is portable across devices: each clone starts its own localhost
daemon and stores its PID and logs only under that clone's `.llm-wiki/`.
`.claude/skills/llm-wiki-builder` is a discoverable entrypoint that points to
the canonical shared Skill, while
`.claude/settings.json` pre-approves all `llm-wiki` tools for the main and
background agents and uses `dontAsk` for unattended extraction. Approve project
trust on first use, then restart Claude Code after changing these files.
The project explicitly disables experimental Agent Teams: extraction workers
are independent named background subagents, so their Agent definitions preload
the shared MCP server and Skill. If an old session reports `Team "wiki-build"
does not exist`, fully restart Claude Code after pulling the project settings;
the coordinator must omit `team_name` rather than creating that Team.
An immediate `Backgrounded agent` acknowledgement is a successful spawn, so
the coordinator launches the rest of the initial worker wave in the same turn;
it does not wait for extractor-1 to finish or emit an intermediate import
summary after only one of the recommended workers has started.

Claude-compatible CAC hosts receive the same project integration under `.cac/`:
settings, all three Agents, and the `llm-wiki-builder` Skill mirror `.claude/`
with only the client name, directory, and `CAC_PROJECT_DIR` placeholder
substituted. A CAC host must explicitly support these project settings, hooks,
and placeholders; the root `.mcp.json` connection itself does not imply that
its CLI command is named `cac`. Both
clients share the root `.mcp.json`, the loopback daemon, and the canonical
`.agents/skills/llm-wiki-builder/` workflow. The files are checked in directly
rather than symlinked for Windows, GitHub archive, and multi-device portability.

Every initial and replacement extraction slot explicitly uses the named project
Agent type `llm-wiki-extractor`. Generic "Worker N", `general-purpose`, and
Agent Team teammates are not used because they do not apply that Agent file's
`mcpServers` declaration. Permissions list all 18 MCP tools explicitly, every
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
coordinator starts manifest/Drafter orchestration before leasing more work.
The Writer starts only after a Drafter stages a receipt. Page-plan responses
never include the full extraction Schema and default to roughly 40K-character
pages, even when the task Schema is several MiB. The main Agent remains
available for questions and coordinates page generation without authoring or
committing pages itself. It fetches only the compact manifest, launches
path-disjoint drafters, and hands their receipts to exactly one stable
background Wiki Writer; only that Writer calls the staged-draft and page-commit
tools. After four new batches, or after a 30-second debounce, the pipeline
incrementally updates affected pages while extractors continue. Each projection
is capped at eight batches;
one coordinator orchestration invocation drains up to six ready projections
(48 batches) when a backlog exists. Incremental plans include full content only for affected pages
and compact catalog metadata for unrelated pages. After incremental catch-up,
the coordinator calls Finalize directly. Core promotes the existing pages
without another semantic rewrite only when its persisted audit proves complete
unique requirement coverage, current task-owned hashes, and exact evidence.
The coordinator requests each server-side page manifest. The manifest declares
the hard 50-patch commit limit and returns bounded draft shards of at most six
canonical paths. Each accepted shard is a durable checkpoint identified by
`draft_shard_ids`; after a restart or context compaction, the coordinator
resumes from the first unfinished shard instead of regenerating earlier pages.
It launches path-disjoint Drafters, then launches the stable Writer only with
completed hash-bound staged receipts. The Writer never launches Drafters and never
fetches manifest or shard context in normal mode. The
legacy full page-plan cursor mode remains available for compatibility.
Incremental pages use concise grounded drafts. When extraction finishes, Core
first drains any remaining bounded projections instead of creating one giant
all-batch final prompt. If the Finalize audit finds ambiguity, contradictions,
review items, incomplete coverage, stale hashes, or incomplete SourceRefs, it
persists those reasons and returns the exact server-side final-projection
action. Only that fallback processes the all-batch shard manifest.

Each extractor invocation handles a bounded quantum of up to six batches,
persisting an independent checkpoint after every batch. This amortizes Agent
startup and Skill-loading time while preserving recovery. On a later turn,
`llm_wiki_status` exposes
`worker_recovery.leases`; relaunching a short-lived extractor with the same
`worker_id` resumes the same batch using a fresh MCP client connection. The
coordinator refills that same worker slot with zero delay whenever extraction
remains; validation exhaustion never waits for lease expiry. The
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

Related navigation is normalized at the Core boundary. Drafters should emit
the same canonical slug in `patch.related` and as `[[collection/slug]]` in the
body. Legacy `wiki/collection/slug.md` bullets inside a Related section and
Markdown links to Wiki pages are accepted and rewritten deterministically, so
frontmatter and body navigation cannot diverge.

## Architecture

```text
Codex / OpenCode current model
  -> .agents/skills/llm-wiki-builder/SKILL.md
  -> llm-wiki MCP over STDIO
Claude Code current model
  -> .claude/skills/llm-wiki-builder/SKILL.md
  -> project-local supervised Streamable HTTP MCP
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
- `llm_wiki_query_domain_pages`
- `llm_wiki_commit_analysis`
- `llm_wiki_get_page_plan_context`
- `llm_wiki_apply_projection` (compatibility redirect)
- `llm_wiki_stage_page_drafts`
- `llm_wiki_get_staged_page_drafts`
- `llm_wiki_commit_pages`
- `llm_wiki_update_pages`
- `llm_wiki_finalize`
- `llm_wiki_status`
- `llm_wiki_list_tasks`
- `llm_wiki_delete_knowledge_base`
- `llm_wiki_abort`
- `llm_wiki_lint`

The server is restricted to the workspace supplied at process startup. Tools do
not accept an arbitrary workspace or project path. The only external paths it
opens are files explicitly passed to `llm_wiki_import_files`; after a safe,
streaming import, all later work uses the managed copy.

The Claude Code startup hook uses `CLAUDE_PROJECT_DIR` rather than a mutable
shell working directory and keeps this bounded 18-tool server loaded for the
session. Ten-second HTTP keep-alive frames, one-minute protocol pings, a
bounded SSE replay window, a supervised worker, Claude's native HTTP reconnect,
bounded transient-tool retries, a 128-session cap, and cleanup after three
consecutive protocol-ping failures protect long-running sessions. MCP
input/output budgets and paginated page-plan context prevent a single oversized
request or response from closing the transport. Set `LLM_WIKI_MCP_HTTP_PORT`
before starting Claude when the default localhost port `31982` conflicts with
another project.
Every tool exception is returned as a normal result (`ok: false`,
`accepted: false`, `error`, `next_action`, and `mcp_connection_usable: true`)
instead of entering MCP's `isError` channel.

`llm_wiki_update_pages` performs bounded post-Finalize maintenance without
reopening a semantic Writer projection. Call it first with `action=inspect` to
obtain the current Wiki revision, exact target file hashes, and either complete
page content or one named Markdown section. Then call `action=apply` with the
same revision, each exact file hash, grounded SourceRefs, section operations,
and an idempotency key. The apply call updates only existing Agent-writable
pages, publishes all changes atomically, rebuilds retrieval/graph/lint
artifacts, and switches `current-generation.json` only after the new generation
is complete. Core-owned Related and Domain Classification sections remain
deterministic and cannot be edited through this tool.

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
omitted, the Analysis schema is represented by a compact contract, and a
Domain Schema contributes only snapshot identity plus disclosure instructions. `batch_limits`
reports chunk-payload bytes and complete-response bytes against a 40 KiB target.
Oversized structured table fields are compacted so pretty-printed MCP JSON does
not contain an unreadable 80K single line. An unfinished legacy batch is
repaired in place while preserving its original batch ID and worker lease.
One chunk is bounded by the smaller of the chunk and batch limits, so legacy
repair does not repeatedly rebuild the same batch or invalidate worker leases.
Each disclosed Schema JSON file may be up to 5 MiB and a complete directory
snapshot up to 20 MiB. Extractors progressively read the complete Domain index,
selected Domain file, and selected ABE files without reconstructing the whole
Schema in Agent context. Core validates against the immutable task snapshot.
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
Schema call. Only an extractor analyzing a complete leased batch skips
BM25/embedding retrieval by default because the finalization audit or semantic
fallback reconciles batches. That optimization does not apply to
coordinator-owned user questions: before answering a factual question about
imported sources or the generated Wiki, the coordinator must call
`llm_wiki_retrieve_context` and ground the answer in its returned hits.

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
each projection stays bounded and independently checkpointed. After catch-up,
Finalize first audits that every batch and requirement is represented exactly
once, no contradiction or review item remains, provisional page hashes still
match the task commits, and exact SourceRefs remain valid. Passing pages are
promoted without a second semantic rewrite. A failed audit persists its reasons
and returns the exact full-reconciliation action; Finalize remains blocked until
that semantic fallback clears all provisional paths.
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
hash. The coordinator resumes its current manifest/Drafter action without an
extra status probe; a newly launched Writer receives only hash-bound staged receipts.

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
llm-wiki.domain-schema/ # optional progressive Domain Schema directory
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
npm run cli -- delete wiki --confirm-delete-knowledge-base --workspace .
npm run cli -- delete knowledge_base --confirm-delete-knowledge-base --workspace .
npm run cli -- migrate-legacy raw/sources --workspace .
```

Deletion is deliberately explicit. `wiki` removes generated Wiki pages and
retrieval indexes but keeps imported sources and task history. `knowledge_base`
also removes managed sources, task state, journals, and staging while retaining
workspace configuration and the schema. Active tasks must be finished or
aborted first.

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
