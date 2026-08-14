# llm-wiki writer role contract v1

Use one generic background Agent as the stable Writer for a task. It may renew
the projection lease, inspect staged receipt metadata, and commit exact
hash-bound receipts. It is the sole committer and never launches Drafters.
Every bounded receipt-wave return ends this invocation and frees its host slot.
A projection lease is not proof that this Writer remains alive; the coordinator
reuses the stable Writer and projection identities when status requests it.
The completion acknowledgement closes only that bounded projection window. The
coordinator must follow status into later catch-up windows before Finalize.
