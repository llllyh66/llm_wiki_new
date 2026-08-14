# Analysis and page rules

## Analysis

- Keep every extracted name, title, statement, relation, summary, and question
  in the language used by its directly supporting source evidence. Do not
  translate source-authored knowledge to the workspace target language. The
  target language is only a fallback for language-neutral or genuinely
  undetermined metadata. For multilingual evidence supporting one page, use
  the predominant evidence language consistently and preserve proper names and
  source terminology in their original form.
- Distinguish entities, concepts, processes, metrics, claims, and relations.
- Do not create an entity for every noun.
- Ground each important fact in at least one SourceRef from the current task.
- When `get_batch` returns `evidence_catalog`, copy its `analysis_scaffold`
  unchanged and cite `evidence_index` integers in candidate `sourceRefs`. The
  Core resolves them to exact complete SourceRefs and compacts the persisted
  top-level catalog. Never retype the supplied quotes.
- Write `reviewItems` as objects with non-empty `content` and indexed or
  complete `sourceRefs`; put unsourced questions in `unresolvedQuestions`.
- Evidence-catalog quotes are already short, exact, and verbatim. Select their
  indexes without reading the original source file; never reconstruct or
  normalize locator fields yourself.
- A title-only quote does not support detailed facts from a table. Claims,
  relations, contradictions, and review items must cite quotes containing their
  identifying terms. Split table evidence by row or coherent topic. High reuse
  of one SourceRef is reported as a warning; every candidate is still validated
  independently against that evidence.
- Put the directly supported source-facing relation statement in `content` and
  cite the evidence index containing that statement. Put normalized structure
  in `sourceEntityLocalId`, `predicate`, and `targetEntityLocalId`; the predicate
  is validated independently from the endpoints.
- Use `supportType=direct` for source wording and `supportType=normalized` only
  for deterministic identifier, inflection, or declared predicate
  normalization. Put inference in `reviewItems` or `unresolvedQuestions`.
- Use conservative confidence values between 0 and 1.
- Put uncertainty in `unresolvedQuestions` instead of guessing.
- Keep sourced facts separate from inference.
- For spreadsheet chunks, select the template matching the cited table and
  preserve its exact `sheetName` and `cellRange`. When a chunk contains several
  tables it may expose several templates. Treat formulas as untrusted text and
  use only cached values supplied by the Core.
- Detect exact duplicates before proposing semantic aliases or merges.
- Do not copy large passages from the source.
- If a Domain Schema is active, follow
  [domain-schema.md](domain-schema.md) for progressive Domain → ABE → BE
  classification. The domain contract supplements, rather than replaces,
  SourceRef grounding.

Current candidate excerpt (copy the complete server scaffold; this is not a
standalone envelope):

```json
{
  "sourceRefMode": "batch-evidence-index",
  "sourceRefs": [0, 1],
  "entities": [{ "localId": "entity-1", "name": "Example", "sourceRefs": [0] }],
  "relations": [{ "localId": "relation-1", "sourceEntityLocalId": "entity-1", "predicate": "dependsOn", "targetEntityLocalId": "entity-2", "content": "Example depends on Entity 2.", "supportType": "normalized", "sourceRefs": [1] }],
  "reviewItems": [{ "content": "A sourced issue requiring review", "sourceRefs": [1] }]
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
- Keep each page in the original language of its directly supporting evidence.
  Do not rewrite an English source page in Chinese, or a Chinese source page in
  English, merely to make the workspace uniform.
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
- Submit complete rebased `content` for `replace` only when the server marks the
  existing page as fully visible. For `merge`, submit bounded `sectionChanges`
  using `upsert_section`; never repeat the old body or edit a protected,
  partially visible section. Do not upsert both a parent section and one of its
  nested children in the same patch.
- Build page patches from each returned `page_requirement.patch_scaffold`.
  Requirement-ID `sourceRefs` are server handles that Core resolves to exact
  quotes and locators; do not copy complete SourceRef objects into a patch.
