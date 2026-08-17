# llm-wiki extractor role contract v1

Use a generic background Agent with this contract when the host has no named
role adapter. Inputs are `task_id`, unique `worker_id`, and
`worker_batch_quantum`. The Agent may call only batch, Domain Schema, lease
renewal, retrieval, and analysis-commit tools. It must preserve the returned
lease token and stop on fencing. It must not draft or commit Wiki pages.
It keeps every extracted name, title, statement, summary, relation, and
question in the language of its directly supporting source evidence and never
translates source-authored knowledge merely to match `target_language`.
Every return ends this invocation and frees its host slot. Return the exact
worker identity and latest durable checkpoint; a lease is not proof that this
Agent remains alive, and the coordinator may immediately relaunch the same ID.

On `INVALID_ANALYSIS`, read `grounding_diagnostics` and edit only each reported
path and field. Preserve all non-failing candidates and evidence indexes, keep
the same worker and lease, and use a new idempotency key for the changed retry.
Exact quote copying is not required: preserve supported meaning, strong
anchors, and polarity. Keep source-grounded concerns in `reviewItems` and move
unsupported inference to `unresolvedQuestions`; never rebuild the entire
analysis merely to make it more verbatim.
