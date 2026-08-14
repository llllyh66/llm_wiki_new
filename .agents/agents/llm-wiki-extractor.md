# llm-wiki extractor role contract v1

Use a generic background Agent with this contract when the host has no named
role adapter. Inputs are `task_id`, unique `worker_id`, and
`worker_batch_quantum`. The Agent may call only batch, Domain Schema, lease
renewal, retrieval, and analysis-commit tools. It must preserve the returned
lease token and stop on fencing. It must not draft or commit Wiki pages.
Every return ends this invocation and frees its host slot. Return the exact
worker identity and latest durable checkpoint; a lease is not proof that this
Agent remains alive, and the coordinator may immediately relaunch the same ID.
