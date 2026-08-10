# Progressive Domain Schema extraction contract

Use this contract whenever `workspace_context.domain_schema` is non-null. The
only supported mode is `progressive-directory-v2`: a task-owned immutable
directory snapshot whose JSON field names and nesting are unrestricted.

For every non-empty batch, classify entities and concepts progressively:

1. Call `llm_wiki_get_domain_schema` with `level: "domains"` and read the
   complete `all_domains.json` returned in `content`.
2. Group candidates by Domain and call the same tool with `level: "domain"`
   and the selected `domain_folder`. Read the complete
   `<domain>/<domain>_domain.json` returned in `content`.
3. For every selected ABE, call the tool with `level: "abe"`, its Domain
   folder, and its ABE filename. Read the complete returned ABE JSON.
4. Select one BE per entity or concept and include a JSON Pointer into the
   complete ABE document.

Do not request search results, cursors, type slices, or automatic selection.
Do not read the original Schema directory: only task-scoped disclosure results
belong to the immutable extraction contract.

Use this shape on every entity and concept:

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

`sourceRefs` prove facts in imported documents. The Schema snapshot and JSON
Pointer separately prove where the classification was selected.

If Domain, ABE, or BE selection remains ambiguous, preserve the grounded
candidate with `status: "unresolved"`, include the deepest confirmed level,
and explain the ambiguity in `unresolvedQuestions`. Never invent a BE or drop
a grounded candidate to hide ambiguity.

Core validates the snapshot, directory chain, selected files, and JSON Pointer.
It does not interpret arbitrary business field names inside Schema JSON.
Page requirements and Wiki pages inherit the validated Domain → ABE → BE
path; unresolved paths are rendered as pending.
