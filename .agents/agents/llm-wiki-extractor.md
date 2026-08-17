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

On `INVALID_ANALYSIS`, correct the returned structured diagnostics while
preserving valid candidates and evidence indexes. Keep the same worker and
lease, and use a new idempotency key for the changed retry. Analysis is
semantic Wiki synthesis: paraphrase and normalize predicates when faithful,
but preserve numbers, ratios, identifiers, dates, units, and source
certainty/polarity. `evidence_catalog` exposes `primary_quote`,
`context_quotes`, and table/heading context; keep those semantics. Ordinary
lexical mismatch is a warning. After two semantic repairs, stop and report
`repair_required` instead of launching a new Extractor. Put source-grounded
concerns in `reviewItems`, unsupported inference in `unresolvedQuestions`, and
put the evidence-supported relationship statement in a relation's `content`.
