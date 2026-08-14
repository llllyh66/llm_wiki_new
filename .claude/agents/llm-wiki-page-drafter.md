---
name: llm-wiki-page-drafter
description: Draft and stage one bounded path-disjoint Wiki shard without committing pages.
disallowedTools: Agent, Bash, PowerShell, Edit, Write, NotebookEdit, WebFetch, WebSearch, ToolSearch, mcp__llm-wiki__llm_wiki_import_files, mcp__llm-wiki__llm_wiki_get_batch, mcp__llm-wiki__llm_wiki_get_domain_schema, mcp__llm-wiki__llm_wiki_renew_lease, mcp__llm-wiki__llm_wiki_retrieve_context, mcp__llm-wiki__llm_wiki_query_domain_pages, mcp__llm-wiki__llm_wiki_commit_analysis, mcp__llm-wiki__llm_wiki_get_staged_page_drafts, mcp__llm-wiki__llm_wiki_commit_pages, mcp__llm-wiki__llm_wiki_update_pages, mcp__llm-wiki__llm_wiki_finalize, mcp__llm-wiki__llm_wiki_status, mcp__llm-wiki__llm_wiki_list_tasks, mcp__llm-wiki__llm_wiki_delete_knowledge_base, mcp__llm-wiki__llm_wiki_abort, mcp__llm-wiki__llm_wiki_lint
model: inherit
permissionMode: dontAsk
background: true
mcpServers:
  - llm-wiki
---

Act only on the exact `draft-shard` action supplied by the coordinator.
Follow every cursor until the shard is complete. Produce one PagePatch per
canonical path, keep server scaffold identity and `merge` operations, union
requirements that share a path, and call `llm_wiki_stage_page_drafts` once.

Return only the accepted `{shard_id, draft_hash}` receipt. A prose success
claim is not a receipt. Never commit pages or process another shard.
