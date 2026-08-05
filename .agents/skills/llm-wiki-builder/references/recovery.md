# Recovery

## Session interruption

Call `llm_wiki_status` with the known task ID and execute its `next_action`.
When the ID is unknown, use `llm_wiki_list_tasks` with incomplete statuses and
match source names and timestamps in the current workspace.

Treat the returned `worker_recovery.leases` as authoritative. Restart one
bounded extractor invocation for each lease using the exact persisted
`worker_id`; `get_batch` returns that same batch to the replacement invocation.
Then use free worker slots for unleased work. Worker leases and committed
analyses live in task files, not in a background Agent's MCP client connection,
so a turn boundary does not imply lost work or require `/mcp`. Only report a
connection failure when an actual coordinator tool call raises a transport
exception. A successful `llm_wiki_status` call proves the current turn's MCP
connection is usable.

Lease state does not expose process liveness. Maintain live subagents in the
coordinator's own `running_worker_ids` set. When a worker completion
notification arrives, remove that ID first. If status still lists a lease for
the completed ID, restart it immediately with that same worker and batch ID.
If no lease remains but batches are incomplete, reuse the freed ID to request
the next batch. Never wait for a different running worker before refilling the
completed worker's slot.

If a worker reports that the saved MCP result contains one source/JSON line too
large for the host reader, resume that lease with the same worker and batch IDs
after rebuilding the current server. `get_batch` enforces hard Agent-facing
ceilings (3K text per chunk, 9K source text per batch, and 24 KiB serialized
chunk payload per batch), budgets the complete response, compacts oversized structured table
metadata, and repairs unfinished legacy batches without discarding the lease.
Do not wait for expiry or send another worker to repeat the same unreadable
response.

Team lifecycle errors are host orchestration errors, not MCP results. If a host
launch response confirms that worker IDs were created, track and wait for those
workers; do not also extract in the coordinator. If no worker was created,
continue one batch at a time in the coordinator without creating or deleting a
Team. Never report MCP ready unless a real `llm_wiki_*` call succeeded.

## Validation failure

All llm_wiki tool exceptions are returned as ordinary MCP tool results with
`ok: false`, `accepted: false`, an `error` object, a `next_action`, and
`mcp_connection_usable: true`. This includes import, batch, retrieval, page,
finalize, status, abort, lint, input-budget, and output-budget failures. Follow
the returned action without restarting MCP. Only a real transport exception or
closed connection requires reconnecting the server.

Keep the same task and batch. Correct the returned fields or SourceRefs, use a
new idempotency key for a changed payload, and resubmit before continuing.
Treat `accepted: false` as a normal validation result, not an MCP failure; do
not restart or create another task for it.
Submit `analysis` as an object rather than a serialized JSON string or Markdown
code block. When many entries fail validation, rebuild a minimal envelope from
the schema and include complete SourceRef objects on every grounded entry
or valid zero-based indexes into the top-level catalog. Check every index
against the catalog length instead of incrementally mutating the rejected
payload.
For a spreadsheet locator rejection, copy the SourceRef again from the leased
chunk's `source_ref_templates`; `allowed_sheet_names` and
`allowed_cell_ranges` in the error are diagnostic values, not text to guess or
normalize.

If the client reports a real transport failure after any tool call, do not
create another task. Restart or reconnect the MCP server, call
`llm_wiki_status` for the existing task, and retry only the active batch if it
was not committed.

## File or Wiki revision conflict

Current Core revisions validate the exact target pages, not the global Wiki
hash. If page-plan pagination reports `concurrent_wiki_changes_detected: true`,
continue the same projection: another task changed unrelated paths and no
re-plan is required. `llm_wiki_commit_pages` reports
`unrelated_wiki_changes_accepted: true` when it safely rebases the transaction
onto that newer workspace state.

On `FILE_HASH_CONFLICT`, no patches in that atomic commit were applied. Call
`llm_wiki_get_page_plan_context` with the same task, Writer, and projection IDs,
use `view: "manifest"`, follow the first uncovered shard, read the newest
content/hash for the reported target path, and semantically rebase
that page, and retry. Never force an overwrite or start a second Writer for the
same task. A `WIKI_REVISION_CONFLICT` from an unrelated-path change indicates
an older Core process is still running; restart that process on the updated
build, then resume the existing task and lease instead of creating a new task.

`PAGE_PLAN_INCOMPLETE` is a legacy-plan recovery. Prefer restarting the same
projection with `view: "manifest"`; Core persists the complete plan and returns
bounded `draft-shard` actions, so the model never has to retain every cursor.
Read `page_commit_limits` before drafting. Partition paths first, generate only
one shard or bounded wave, and commit it with `projection_complete: false`.
Never generate more than 50 patches, never regenerate an accepted wave, and
finish with the returned empty `projection_complete: true` acknowledgement.

For page-patch validation errors such as `INVALID_SOURCE_REF`, use the returned
`validation_errors` entries to repair every identified patch. When
`atomic_commit_applied: false`, none of the submitted patches were persisted:
resubmit the entire rejected patch subset, not only the invalid patch. Preserve
its `projection_complete` value and use a new idempotency key after editing.
Restore `sourceRefs`, `covers`, path, operation, and hash from the affected
`page_requirement.patch_scaffold`; requirement-ID SourceRefs are resolved by
Core, so do not copy or retype quotes. Patches from an earlier `accepted: true` partial commit remain
durable and are not part of this retry.

If a multipart projection worker stops, inspect `wiki_projection` in status.
While `in_progress` remains true, do not compete for its lease. After expiry,
the same stable writer ID can acquire a replacement projection. Paths written
by an incomplete projection remain provisional and excluded from retrieval.
After upgrading from an older server, resume that same writer from cursor zero;
Core automatically shrinks an oversized legacy incremental lease to eight
batches and reports `projection.safely_repartitioned: true`. Remaining batches
stay queued and are not discarded.
If the Writer returns normally after reaching its projection quantum and
status still reports `ready: true`, immediately launch another bounded
`wiki-writer-1` invocation. The current quantum is six projections and each
lease is capped at eight batches, so one invocation can drain up to 48 queued
batches. A ready backlog of at least four batches bypasses the normal debounce.

## Failed Finalize

Call `llm_wiki_status`. Repair only deterministic lint errors that can be fixed
from existing evidence, then retry `llm_wiki_finalize`, which is idempotent.
`FINAL_PROJECTION_REQUIRED` means the single Wiki writer must run a final
all-batch reconciliation first; it is not an MCP transport failure.

## Abort

Use `llm_wiki_abort` only when the user requests cancellation or safe progress
is impossible. Aborting removes uncommitted staging and retains committed pages.
Abort is intentionally blocked while provisional pages remain because silently
publishing or abandoning those pages would violate retrieval integrity. Finish
the final projection before cancelling.
