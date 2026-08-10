# Domain Schema extraction contract

## Progressive directory Schema V2

When `workspace_context.domain_schema.mode` is `progressive-directory-v2`, the
Schema is a task-owned immutable directory snapshot. The JSON files are valid
JSON but their internal field names and nesting are intentionally unrestricted.
Do not expect `entityTypes`, `conceptTypes`, `relationTypes`, or any other fixed
input shape.

For every non-empty batch, classify entities and concepts progressively:

1. Call `llm_wiki_get_domain_schema` with `level: "domains"` and read the
   complete `all_domains.json` returned in `content`.
2. Group candidates by the selected Domain folder and call the same tool with
   `level: "domain"` and that `domain_folder`. Read the complete
   `<domain>/<domain>_domain.json` returned in `content`.
3. For each selected ABE call the tool with `level: "abe"`, the Domain folder,
   and the ABE filename. The returned ABE JSON is complete; never request a
   search result, cursor, or abbreviated type list.
4. Select one BE per entity or concept from the complete ABE JSON. Include a
   JSON Pointer into that ABE document so Core can verify the selection.

Use this output shape on each entity and concept:

```json
{
  "schemaClassification": {
    "status": "classified",
    "confidence": 0.91,
    "domain": { "key": "customer", "name": "客户域" },
    "abe": { "key": "customer_management", "name": "客户管理", "file": "customer_management.json" },
    "be": { "key": "customer_management#/businessEntities/2", "name": "个人客户", "pointer": "/businessEntities/2" }
  }
}
```

`sourceRefs` prove facts in the imported documents. They are separate from the
Schema file and JSON Pointer used to prove the classification choice.

If Domain, ABE, or BE selection remains ambiguous, preserve the source-grounded
candidate with `status: "unresolved"`, include the deepest confirmed level and
the reason in `unresolvedQuestions`, and never invent a BE. Core validates the
directory chain, snapshot/file hashes, and JSON Pointer; it does not validate
business field names inside arbitrary JSON.

Page requirements and Wiki pages inherit the classification path. The Core-owned
page section renders `Domain → ABE → BE` and marks unresolved paths as pending.

The remainder of this file documents the V1 fixed-object Schema contract for
existing tasks that are being resumed. Do not apply its entityTypes/property or
relationTypes rules to a V2 progressive directory task.

Use this contract only when `llm_wiki_get_batch` returns a non-null
`workspace_context.domain_schema`. The task owns a validated snapshot, so do
not reload or reinterpret a later version of the source Schema file mid-task.
When `workspace_context.domain_schema_pagination.required` is true, the inline
value is only a summary. First inspect
`workspace_context.domain_schema_auto_selection`. When it is `ready: true`, its
items contain the complete extraction constraints (canonical IDs, names,
aliases, property types/required/unique flags, and relation endpoints) selected
deterministically from labels present in the batch; verbose descriptions are
omitted from this hot path. Use them without another MCP call. Only when it is
absent/false or semantically ambiguous, search the
server-side snapshot with `llm_wiki_get_domain_schema` mode `search`. When
needed, use mode `catalog` for bounded summaries and mode `types` with exact
IDs. The Core still validates the
analysis against the entire snapshot, so selection reduces Agent context but
does not weaken the Schema contract. Never use memory search or read the
original Schema file as a substitute for these task-scoped results.

## Entity output

For every domain entity, emit:

```json
{
  "localId": "subject-c-001",
  "name": "张三",
  "entityTypeId": "business_subject",
  "properties": {
    "subject_id": "C-001",
    "subject_name": "张三"
  },
  "sourceRefs": [0]
}
```

- Prefer stable type and property `id` values from the Schema.
- In `compatible` mode, names and aliases are accepted and normalized, but IDs
  remain less ambiguous.
- Include every `required` property only when the source explicitly supplies
  its value. Never manufacture an identifier, status, timestamp, or result.
- Honor each property's `valueType`. Preserve date/datetime values as sourced
  strings unless the Schema says otherwise.
- If required evidence is absent, omit that entity and add an unsourced concern
  to `unresolvedQuestions`; do not submit a knowingly invalid placeholder.

## Optional concept types

When the task Schema exposes `conceptTypes`, a sourced concept may include its
canonical `conceptTypeId`:

```json
{
  "localId": "concept-service-quality",
  "name": "服务质量",
  "conceptTypeId": "service_quality",
  "sourceRefs": [0]
}
```

Concepts remain valid and general when no `conceptTypes` are defined. Do not
invent a concept type merely to populate a page.

## Relation output

If `relationTypes` is empty, skip all domain-level relation validation rules in
this section. Continue extracting source-grounded relations using the general
AnalysisEnvelope candidate shape; `relationTypeId`, typed endpoints, and
Schema-defined relation properties are not required.

If `relationTypes` is non-empty, relations point to retained entity `localId`
values and must use a defined relation type:

```json
{
  "localId": "owns-c-001-o-100",
  "name": "拥有",
  "relationTypeId": "subject_owns_object",
  "sourceEntityLocalId": "subject-c-001",
  "targetEntityLocalId": "object-o-100",
  "properties": {},
  "content": "客户 C-001 拥有产品 O-100。",
  "sourceRefs": [0]
}
```

- The source and target entity types must be allowed by the relation type.
- Do not emit a relation unless both endpoints are present in this batch and the
  source explicitly supports the relation.
- Relation properties follow the same ID, unknown-property, and value-type
  rules as entity properties.

## Policies and results

- `strict`: use exact IDs only.
- `compatible`: IDs, names, and aliases can resolve to canonical IDs.
- `reject-batch`: any domain violation returns recoverable
  `INVALID_DOMAIN_ANALYSIS`; correct the payload and retry the same batch.
- `drop-invalid`: normal Skill calls still use Schema-first preflight. If any
  candidate is invalid, the Core rejects before persistence so the worker can
  correct it. Only an explicit user-approved
  `accept_dropped_candidates: true` commit removes invalid entities and, when
  `relationTypes` is non-empty, dependent or incompatible relations. That
  successful opt-in commit reports violations and dropped counts.
- Unknown types and properties are allowed only when their matching policy flag
  is true.

Schema validation is deterministic Core behavior. Semantic classification and
evidence selection remain the host Agent's responsibility.
