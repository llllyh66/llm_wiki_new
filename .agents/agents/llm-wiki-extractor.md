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
Judge candidates by evidence support, not wording identity. Preserve semantic
normalization and entity canonicalization. Core does not validate candidate
wording or lexical overlap; never rewrite content merely to copy evidence
wording. A table-row evidence index
automatically includes its exact header SourceRef; keep supported column labels.
Keep source-grounded concerns in `reviewItems` and unsupported inference in
`unresolvedQuestions`. Create a Relation only when evidence
supports its endpoints, direction, and predicate; express a supported risk or
failure consequence as a Claim rather than inventing a dependency. Inspect all
diagnostics returned for the candidate and do not rebuild the entire analysis.
