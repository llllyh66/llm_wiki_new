# Domain Schema extraction contract

Use this contract only when `llm_wiki_get_batch` returns a non-null
`workspace_context.domain_schema`. The task owns a validated snapshot, so do
not reload or reinterpret a later version of the source Schema file mid-task.
When `workspace_context.domain_schema_pagination.required` is true, the inline
value is only a summary. Read `llm_wiki_get_domain_schema` from cursor `0`
through a null `next_cursor` and reconstruct all ordered type and property
items before classifying any entity or relation.

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
- `drop-invalid`: invalid entities are removed. When `relationTypes` is
  non-empty, relations pointing to removed or incompatible endpoints are also
  removed. A successful commit returns `domain_validation` with violations and
  dropped counts.
- Unknown types and properties are allowed only when their matching policy flag
  is true.

Schema validation is deterministic Core behavior. Semantic classification and
evidence selection remain the host Agent's responsibility.
