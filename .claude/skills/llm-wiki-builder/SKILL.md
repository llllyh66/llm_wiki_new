---
name: llm-wiki-builder
description: Build, rebuild, resume, or incrementally update a source-grounded local llm_wiki knowledge base from attached documents or explicit local paths.
---

# Claude Code entrypoint

Before doing any task work, read the canonical
[llm-wiki-builder Skill](../../../.agents/skills/llm-wiki-builder/SKILL.md)
completely and follow it as the controlling workflow.

Resolve every relative reference in that canonical Skill against
`.agents/skills/llm-wiki-builder/`, including `references/analysis-rules.md`
and, when directed by the canonical Skill, `references/domain-schema.md` or
`references/recovery.md`. Pass the user's arguments and attached files into
that workflow unchanged.
