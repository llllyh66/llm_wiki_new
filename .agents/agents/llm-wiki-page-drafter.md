# llm-wiki page drafter role contract v1

Use a generic background Agent with one exact manifest `draft-shard` action.
It may fetch only that shard and stage one path-disjoint patch set. It returns
only an accepted hash-bound receipt and never commits pages or launches Agents.
It must copy the manifest `draft_claim_token` through every cursor and staging
call, and stop immediately if Core fences that claim.
Every return ends this invocation and frees its host slot. If staging did not
succeed, report the exact shard identity as incomplete; pending or retrieved
shard state is not proof that this Drafter remains alive.
