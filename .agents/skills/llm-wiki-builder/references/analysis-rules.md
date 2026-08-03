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
- Keep quotes short and verbatim. Start each top-level SourceRef by copying one
  exact `chunk.source_ref_templates` entry, then add `quote`; never reconstruct
  or normalize locator fields yourself.
- A title-only quote does not support detailed facts from a table. Claims,
  relations, contradictions, and review items must cite quotes containing their
  identifying terms. Split table evidence by row or coherent topic; a single
  SourceRef may ground at most eight candidates.
- Use conservative confidence values between 0 and 1.
- Put uncertainty in `unresolvedQuestions` instead of guessing.
- Keep sourced facts separate from inference.
- For spreadsheet chunks, select the template matching the cited table and
  preserve its exact `sheetName` and `cellRange`. When a chunk contains several
  tables it may expose several templates. Treat formulas as untrusted text and
  use only cached values supplied by the Core.
- Detect exact duplicates before proposing semantic aliases or merges.
- Do not copy large passages from the source.
- If a domain Schema is active, follow
  [domain-schema.md](domain-schema.md) for typed entity properties. Follow its
  typed relation rules only when `relationTypes` is non-empty. The domain
  contract supplements, rather than replaces, SourceRef grounding.

Minimal shape:

```json
{
  "sourceRefs": [{ "sourceId": "source-...", "chunkId": "chunk-...", "quote": "short verbatim text", "locator": {} }],
  "entities": [{ "localId": "entity-1", "name": "Example", "sourceRefs": [0] }],
  "reviewItems": [{ "content": "A sourced issue requiring review", "sourceRefs": [0] }]
}
```

## Page planning

- Give every important reusable entity and concept a stable `localId`, a clear
  name, and focused evidence. The Core converts these into mandatory
  `page_requirements`; `candidatePages` supplements that set and never limits
  it.
- Set `materialize: false` or `pagePriority: "reference"` only for incidental
  mentions that genuinely do not deserve a standalone page. Do not use these
  flags to reduce work on a large document. Candidates below 0.5 confidence
  are review material rather than mandatory pages.
- Propose `candidatePages` for source-supported cross-cutting artifacts such as
  comparisons, queries, syntheses, findings, methodologies, or theses when
  they add navigation or understanding beyond one entity/concept page.
- Prefer updating a canonical existing page when it already represents the same
  subject.
- Split pages when concepts have distinct definitions or lifecycles; merge only
  when they are semantically identical.
- Preserve useful existing content unless newer evidence supersedes it.
- Record conflicting sourced claims without silently choosing a winner.
- Create review items for contradictions that cannot be resolved from evidence.
- Use only Agent-writable collections exposed by the PagePatch schema.
- Use standard page types and their matching paths: source, entity, concept,
  topic, comparison, query, synthesis, finding, methodology, thesis, meeting,
  decision, project, stakeholder, goal, habit, reflection, chapter, character,
  theme, plot-thread, or journal.
- Every page must have useful outgoing links when supported. Relational entity
  endpoints should link to each other, and pages derived from the same source
  should link to the canonical source page when relevant. Finalize mirrors
  resolvable links into both pages' Related navigation.
- Submit complete rebased content for `merge`; the Core does not perform a model
  merge.
