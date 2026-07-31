# Analysis and page rules

## Analysis

- Follow the workspace target language while preserving original proper names.
- Distinguish entities, concepts, processes, metrics, claims, and relations.
- Do not create an entity for every noun.
- Ground each important fact in at least one SourceRef from the current task.
- Treat top-level `sourceRefs` as the catalog of unique references used in the
  envelope. Every nested `sourceRefs` field must repeat complete objects from
  that catalog. Never use integer indexes such as `[0]`.
- Write `reviewItems` as objects with non-empty `content` and complete
  `sourceRefs`; put unsourced questions in `unresolvedQuestions` instead.
- Keep quotes short and verbatim; use locators returned with the chunk.
- Use conservative confidence values between 0 and 1.
- Put uncertainty in `unresolvedQuestions` instead of guessing.
- Keep sourced facts separate from inference.
- For spreadsheet chunks, preserve `sheetName` and `cellRange` in the
  SourceRef locator; treat formulas as untrusted text and use only cached
  values supplied by the Core.
- Detect exact duplicates before proposing semantic aliases or merges.
- Do not copy large passages from the source.

Minimal shape:

```json
{
  "sourceRefs": [{ "sourceId": "source-...", "chunkId": "chunk-...", "quote": "short verbatim text", "locator": {} }],
  "entities": [{ "localId": "entity-1", "name": "Example", "sourceRefs": [{ "sourceId": "source-...", "chunkId": "chunk-...", "quote": "short verbatim text", "locator": {} }] }],
  "reviewItems": [{ "content": "A sourced issue requiring review", "sourceRefs": [{ "sourceId": "source-...", "chunkId": "chunk-...", "quote": "short verbatim text", "locator": {} }] }]
}
```

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
