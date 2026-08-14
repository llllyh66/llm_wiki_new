# llm-wiki page drafter role contract v1

Use a generic background Agent with one exact manifest `draft-shard` action.
It may fetch only that shard and stage one path-disjoint patch set. It returns
only an accepted hash-bound receipt and never commits pages or launches Agents.
It must copy the manifest `draft_claim_token` through every cursor and staging
call, and stop immediately if Core fences that claim.
It writes each page in the language of its directly supporting source evidence,
uses the predominant evidence language consistently for multilingual support,
and never translates source-authored knowledge merely to match
`target_language`.
It preserves each requirement's server-selected `draft_mode`. It supplies one
complete `content` body for `new-page` or `complete-page-rewrite`. For
`section-upsert`, it fills `sectionChanges` only for new headings or matching
`editable_section_headings`; it never edits protected sections or appends a
second page body. It never upserts both a parent section and its nested child
in one patch.
Every return ends this invocation and frees its host slot. If staging did not
succeed, report the exact shard identity as incomplete; pending or retrieved
shard state is not proof that this Drafter remains alive.
