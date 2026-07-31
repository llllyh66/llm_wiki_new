# Analysis and page rules

## Analysis

- Follow the workspace target language while preserving original proper names.
- Distinguish entities, concepts, processes, metrics, claims, and relations.
- Do not create an entity for every noun.
- Ground each important fact in at least one SourceRef from the current task.
- Treat top-level `sourceRefs` as the catalog of unique references used in the
  envelope. Prefer zero-based integer catalog indexes in nested `sourceRefs`;
  verify every index is smaller than the catalog length. The Core accepts full
  objects for compatibility and always persists resolved complete objects.
- Write `reviewItems` as objects with non-empty `content` and indexed or
  complete `sourceRefs`; put unsourced questions in `unresolvedQuestions`.
- Keep quotes short and verbatim; use locators returned with the chunk.
- A title-only quote does not support detailed facts from a table. Claims,
  relations, contradictions, and review items must cite quotes containing their
  identifying terms. Split table evidence by row or coherent topic; a single
  SourceRef may ground at most eight candidates.
- Use conservative confidence values between 0 and 1.
- Put uncertainty in `unresolvedQuestions` instead of guessing.
- Keep sourced facts separate from inference.
- For spreadsheet chunks, preserve `sheetName` and `cellRange` in the
  SourceRef locator; treat formulas as untrusted text and use only cached
  values supplied by the Core.
- Detect exact duplicates before proposing semantic aliases or merges.
- Do not copy large passages from the source.
- If a domain Schema is active, follow
  [domain-schema.md](domain-schema.md) for typed entity properties and relation
  endpoints. The domain contract supplements, rather than replaces, SourceRef
  grounding.

Minimal shape:

```json
{
  "sourceRefs": [{ "sourceId": "source-...", "chunkId": "chunk-...", "quote": "short verbatim text", "locator": {} }],
  "entities": [{ "localId": "entity-1", "name": "Example", "sourceRefs": [0] }],
  "reviewItems": [{ "content": "A sourced issue requiring review", "sourceRefs": [0] }]
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
