# Recovery

## Session interruption

Call `llm_wiki_status` with the known task ID and execute its `next_action`.
When the ID is unknown, use `llm_wiki_list_tasks` with incomplete statuses and
match source names and timestamps in the current workspace.

Treat the returned `worker_recovery.leases` as authoritative. Restart one
single-batch extractor invocation for each lease using the exact persisted
`worker_id`; `get_batch` returns that same batch to the replacement invocation.
Then use free worker slots for unleased work. Worker leases and committed
analyses live in task files, not in a background Agent's MCP client connection,
so a turn boundary does not imply lost work or require `/mcp`. Only report a
connection failure when an actual coordinator tool call raises a transport
exception. A successful `llm_wiki_status` call proves the current turn's MCP
connection is usable.

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

If the client reports a real transport failure after any tool call, do not
create another task. Restart or reconnect the MCP server, call
`llm_wiki_status` for the existing task, and retry only the active batch if it
was not committed.

## File or Wiki revision conflict

For a leased projection, discard its remaining plan and call
`llm_wiki_get_page_plan_context` with the same writer ID to acquire a fresh
projection. Read the latest page content and hash, semantically rebase the
proposed content, then submit a new patch with the latest `expectedFileHash`
and `based_on_wiki_revision`. Never force an overwrite or start a second Wiki
writer.

If a multipart projection worker stops, inspect `wiki_projection` in status.
While `in_progress` remains true, do not compete for its lease. After expiry,
the same stable writer ID can acquire a replacement projection. Paths written
by an incomplete projection remain provisional and excluded from retrieval.

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
