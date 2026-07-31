# Recovery

## Session interruption

Call `llm_wiki_status` with the known task ID and execute its `next_action`.
When the ID is unknown, use `llm_wiki_list_tasks` with incomplete statuses and
match source names and timestamps in the current workspace.

## Validation failure

Keep the same task and batch. Correct the returned fields or SourceRefs, use a
new idempotency key for a changed payload, and resubmit before continuing.
Submit `analysis` as an object rather than a serialized JSON string or Markdown
code block. When many entries fail validation, rebuild a minimal envelope from
the schema and include valid SourceRefs on every grounded entry instead of
incrementally mutating the rejected payload.

If the client reports a transport failure after `llm_wiki_commit_analysis`, do
not create another task. Restart or reconnect the MCP server, call
`llm_wiki_status` for the existing task, and retry only the active batch if it
was not committed.

## File or Wiki revision conflict

Call `llm_wiki_get_page_plan_context` again. Read the latest page content and
hash, semantically rebase the proposed content, then submit a new patch with the
latest `expectedFileHash` and `based_on_wiki_revision`. Never force an overwrite.

## Failed Finalize

Call `llm_wiki_status`. Repair only deterministic lint errors that can be fixed
from existing evidence, then retry `llm_wiki_finalize`, which is idempotent.

## Abort

Use `llm_wiki_abort` only when the user requests cancellation or safe progress
is impossible. Aborting removes uncommitted staging and retains committed pages.
