# Analysis and page rules

## Analysis

- Follow the workspace target language while preserving original proper names.
- Distinguish entities, concepts, processes, metrics, claims, and relations.
- Do not create an entity for every noun.
- Ground each important fact in at least one SourceRef from the current task.
- Keep quotes short and verbatim; use locators returned with the chunk.
- Use conservative confidence values between 0 and 1.
- Put uncertainty in `unresolvedQuestions` instead of guessing.
- Keep sourced facts separate from inference.
- Detect exact duplicates before proposing semantic aliases or merges.
- Do not copy large passages from the source.

## Page planning

- Prefer updating a canonical existing page when it already represents the same
  subject.
- Split pages when concepts have distinct definitions or lifecycles; merge only
  when they are semantically identical.
- Preserve useful existing content unless newer evidence supersedes it.
- Record conflicting sourced claims without silently choosing a winner.
- Create review items for contradictions that cannot be resolved from evidence.
- Use only Agent-writable collections exposed by the PagePatch schema.
- Submit complete rebased content for `merge`; the Core does not perform a model
  merge.
