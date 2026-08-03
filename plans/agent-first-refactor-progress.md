# Agent-first refactor progress

Last updated: 2026-07-31

## Scope

The target is a headless, Agent-first knowledge-base engine. The host Agent owns
semantic analysis and page authoring. The Core owns workspace initialization,
managed sources, parsing, batching, retrieval, validation, transactions, indexes,
lint, and recovery. The MCP server is a STDIO adapter over the Core and must not
call a model, an Agent CLI, a desktop API, or an HTTP service.

## Phase 0 audit

### Baseline

- `npm run test:mocks` cannot start in this checkout because dependencies are not
  installed (`vitest: command not found`). This is an environment baseline, not a
  test failure in the source.
- The existing MCP package also has no installed `node_modules` directory.
- The checkout does not contain Git metadata, so changes cannot be compared with
  `git status`; migration work must use direct filesystem inspection.

### Real responsibility map

| Existing responsibility | Real files | Migration decision |
|---|---|---|
| Desktop ingest orchestration and prompts | `src/lib/ingest.ts` | Do not reuse. It imports `streamChat`, UI stores, Tauri filesystem commands, and provider configuration. Semantic rules move to the Skill. |
| Desktop ingest queue and recovery | `src/lib/ingest-queue.ts` | Replace with the Core task store. The old queue is coupled to UI state and desktop project IDs. |
| Source hash cache | `src/lib/ingest-cache.ts` | Replace with content-addressed source objects and source manifests. |
| Markdown chunking | `src/lib/text-chunker.ts` | Design reused: heading breadcrumbs, frontmatter stripping, table/code preservation, deterministic offsets. Reimplemented in the dependency-free Core so there is one headless authority. |
| Office/PDF/ebook parsing | `src-tauri/src/commands/*`, especially `ebook.rs`, `extract_images.rs`, and `fs.rs` | Useful behavior to migrate after the Markdown/TXT slice. Current implementations are Tauri commands and cannot be the Core API. |
| Page merge/write | `src/lib/page-merge.ts`, `src/commands/fs.ts` | Replace with Core-owned optimistic concurrency, staging, atomic rename, rollback, and journal records. No LLM merge is retained. |
| Frontmatter and schema routing | `src/lib/frontmatter.ts`, `src/lib/wiki-schema.ts` | Preserve the structural intent; enforce a smaller deterministic page contract in Core for the first slice. |
| Structural lint | `src/lib/lint-structural-core.ts`, `src/lib/lint.ts` | Reimplement deterministic broken-link/orphan checks in Core. The semantic LLM lint path is deleted. |
| Keyword/vector/graph retrieval | `src-tauri/src/commands/search.rs`, `src/lib/search.ts`, graph modules, embedding modules | Reimplemented in Core across source chunks, committed analysis, and Wiki sections: BM25, configurable OpenAI-compatible/Ollama embeddings with sharded cache and safe fallback, Wiki title/path/bidirectional-link ranking, and RRF fusion. Corpus, candidate, timeout, and response budgets bound large workspaces. |
| Desktop project/state | `src/App.tsx`, `src/components/`, `src/stores/`, `src/lib/project-store.ts` | Delete after the headless E2E is green. Workspace identity replaces project selection. |
| Desktop shell and HTTP APIs | `src-tauri/`, including `api_server.rs`, `clip_server.rs`, window/tray startup | Delete after the headless E2E is green. No HTTP compatibility layer will remain. |
| Built-in model providers | `src/lib/llm-client.ts`, `src/lib/llm-providers.ts`, `src/lib/claude-cli-transport.ts`, `src/lib/codex-cli-transport.ts`, `src-tauri/src/agent/provider.rs` | Delete. Core and MCP are model-free. |
| Existing MCP | `mcp-server/src/index.ts`, `api-client.ts`, `project-binding.ts` | Replace. It is an HTTP proxy for the desktop application, exposes project switching and chat, and cannot satisfy the workspace security boundary. |
| Browser extension and desktop release workflows | `extension/`, `.github/workflows/` | Delete or replace during the desktop removal phase. |

### Existing call graph

```text
React UI / desktop stores
  -> ingest queue
  -> ingest.ts
  -> internal streamChat / provider / Claude CLI / Codex CLI
  -> Tauri filesystem and parser commands
  -> wiki files and desktop state

legacy MCP STDIO
  -> HTTP client
  -> Tauri local HTTP API
  -> desktop project registry / search / chat agent
```

### Target call graph

```text
Codex / OpenCode / Claude Code current model
  -> shared llm-wiki-builder Skill
  -> llm-wiki MCP over STDIO
  -> headless Core library
  -> current workspace: wiki/ + .llm-wiki/
```

## Phase checklist

- [x] Phase 0: inspect repository and record the real mapping and baseline.
- [x] Phase 1: independent model-free Headless Core.
- [x] Phase 2: Markdown/TXT vertical slice and deterministic E2E fixture.
- [x] Phase 3: STDIO MCP server directly calling Core.
- [x] Phase 4: shared Skill and Agent configuration examples.
- [x] Phase 5: OpenCode and Claude Code use the same checked-in MCP command and shared Skill. Host-specific drag/drop remains a manual acceptance check.
- [x] Phase 6: HTML, DOCX, XLSX, PDF, structured Office tables, BM25, local feature-vector cosine, graph neighbors, and RRF.
- [x] Phase 7: desktop UI, Tauri, providers, desktop HTTP API, old MCP proxy, extension, assets, and desktop build/release inputs were physically removed after explicit user approval.
- [x] Phase 8: Headless dependencies, package contents, CI, release workflow, README, Agent configuration, and residual-reference audit are complete. Three-host drag/drop remains an external manual acceptance check rather than a code migration item.

## Deletion gate

Desktop code will only be physically removed after the new automated E2E proves:
managed import, duplicate detection, batching, analysis validation, SourceRef
validation, transactional page commit, hash conflict handling, finalize, BM25,
lint, abort, and recovery without a desktop or HTTP process.

The gate was technically satisfied, and the user subsequently gave explicit
approval for irreversible legacy removal. `src/`, `src-tauri/`, the old
`mcp-server/`, `extension/`, desktop assets/configuration, obsolete translated
desktop READMEs, and old release helpers were physically deleted. This checkout
has no Git metadata, so those deletions are not recoverable from the local
workspace; the retained audit above records their former responsibility map.

## Implemented Headless architecture

- `packages/core`: workspace, source object store, Markdown/TXT/HTML/DOCX/XLSX/PDF
  parsers, structural chunking, persisted tasks, BM25/embedding/Wiki retrieval
  with RRF, bounded domain-Schema pagination,
  SourceRef and path validation, optimistic hashes, staging/rollback/journal,
  Finalize, indexes, lint, status, list, and abort.
- `packages/mcp-server`: STDIO-only MCP adapter that directly imports Core.
- `packages/cli`: model-free init/import/status/lint/abort and legacy-source
  migration.
- `.agents/skills/llm-wiki-builder`: shared Agent workflow, analysis rules, and
  recovery rules.
- `.codex/config.toml`, `opencode.json`, and `.mcp.json`: one MCP command bound
  to the current workspace.

## Test evidence

Latest root commands:

```text
npm run build  -> passed (Core, MCP, CLI)
npm test       -> passed
  Core         -> 6/6
  MCP          -> 3/3, including a spawned STDIO protocol smoke test
  CLI          -> 1/1, including legacy-source migration
npm audit fix  -> production dependency audit reports 0 vulnerabilities
```

The Core suite covers managed-copy survival after deleting the original,
duplicate content, recovery/list/abort, idempotency replay, forged SourceRefs,
path traversal, symbolic links, external edits, stale hashes, transactional
page commit, idempotent Finalize, HTML tables, DOCX table spans, and PDF page
locators. No test invokes a model.

`npm pack --dry-run` also passed for all three workspaces. The MCP and CLI
packages declare the published Core package rather than relying on monorepo-only
relative imports.

`skill-creator`'s `quick_validate.py` was invoked but its Python environment
lacks the `yaml` module. An equivalent local metadata check passed: valid
frontmatter, `llm-wiki-builder` naming, nonempty trigger description, and a UI
default prompt that explicitly references `$llm-wiki-builder`.

## Manual acceptance still required

- Drag/drop attachment path materialization in an actual Codex session.
- The same attachment flow in current OpenCode and Claude Code versions.
- Scanned-PDF OCR; text-layer PDFs are supported and page-traceable.
