import assert from "node:assert/strict"
import test from "node:test"
import {
  applyWikiPageSectionChanges,
  extractRelatedReferences,
  listWikiPageSections,
  parseWikiPage,
  prepareWikiPageContent,
  readWikiPageSection,
} from "../src/wiki-page.js"

function pagePatch(content, related = []) {
  return {
    patchId: "patch-sgsn-detach",
    path: "wiki/entities/sgsninitiateddetach.md",
    operation: "create",
    title: "SGSNInitiatedDetach",
    pageKind: "entity",
    content,
    sourceRefs: [{ sourceId: "source-1" }],
    tags: [],
    related,
    covers: ["page-sgsn-detach"],
    summary: "SGSN-initiated detach workflow.",
  }
}

test("plain Wiki paths in Related sections become matching frontmatter and canonical wikilinks", () => {
  const prepared = prepareWikiPageContent(pagePatch(`# SGSNInitiatedDetach

## Related

- wiki/entities/ueinitiateddetach.md
`), "", "2026-08-06")
  const parsed = parseWikiPage(prepared)

  assert.deepEqual(parsed.related, ["entities/ueinitiateddetach"])
  assert.match(prepared, /related: \["entities\/ueinitiateddetach"\]/)
  assert.match(prepared, /## Related\n\n- \[\[entities\/ueinitiateddetach\]\]/)
  assert.doesNotMatch(prepared, /wiki\/entities\/ueinitiateddetach\.md/)
})

test("Markdown Wiki links and localized Related headings normalize without duplicating sections", () => {
  const prepared = prepareWikiPageContent(pagePatch(`# SGSNInitiatedDetach

See [UE initiated detach](wiki/entities/ueinitiateddetach.md).

## 相关页面

- wiki/entities/sessionrelease.md
`), "", "2026-08-06")
  const parsed = parseWikiPage(prepared)

  assert.deepEqual(parsed.related, ["entities/ueinitiateddetach", "entities/sessionrelease"])
  assert.equal((prepared.match(/^## Related$/gm) ?? []).length, 1)
  assert.doesNotMatch(prepared, /^## 相关页面$/m)
  assert.match(prepared, /- \[\[entities\/sessionrelease\]\]/)
})

test("replace drops stale body facts while merge explicitly retains them", () => {
  const existing = `# SGSNInitiatedDetach

Legacy grounded fact.
`
  const replacePatch = {
    ...pagePatch("# SGSNInitiatedDetach\n\nReconciled grounded fact.\n"),
    operation: "replace",
  }
  const replaced = prepareWikiPageContent(replacePatch, existing, "2026-08-06")
  assert.match(replaced, /Reconciled grounded fact/)
  assert.doesNotMatch(replaced, /Legacy grounded fact/)

  const mergePatch = { ...replacePatch, operation: "merge" }
  const merged = prepareWikiPageContent(mergePatch, existing, "2026-08-06")
  assert.match(merged, /Legacy grounded fact/)
  assert.match(merged, /Reconciled grounded fact/)
})

test("relationship prose and incidental source paths do not become graph edges", () => {
  const content = `# SGSNInitiatedDetach

The source file wiki/entities/not-a-related-page.md is mentioned for migration.

## Relationships

- Related to: UEInitiatedDetach
`
  assert.deepEqual(extractRelatedReferences(content), [])
  assert.deepEqual(parseWikiPage(prepareWikiPageContent(pagePatch(content))).related, [])
  assert.deepEqual(extractRelatedReferences("## Related\n\n- wiki/entities/../sources/private.md"), [])
})

test("code, quote, and inline-code examples do not become relationship edges", () => {
  const content = `# Example

Real prose links to [[entities/real-page]] and [another](wiki/topics/another.md).

\`\`\`markdown
[[topics/in-code]]
[inside](wiki/entities/in-code.md)
\`\`\`

> [[topics/in-quote]]

Inline \`[[topics/in-inline-code]]\` is only an example.

## Related

- wiki/concepts/explicit-related.md
`
  assert.deepEqual(extractRelatedReferences(content), [
    "entities/real-page",
    "topics/another",
    "concepts/explicit-related",
  ])
})

test("explicit patch Related values are mirrored into the body and self-links are removed", () => {
  const prepared = prepareWikiPageContent(pagePatch(
    "# SGSNInitiatedDetach\n\nGrounded description.",
    ["entities/ueinitiateddetach", "entities/sgsninitiateddetach"],
  ))
  const parsed = parseWikiPage(prepared)

  assert.deepEqual(parsed.related, ["entities/ueinitiateddetach"])
  assert.match(prepared, /## Related\n\n- \[\[entities\/ueinitiateddetach\]\]/)
})

test("incremental section changes ignore fenced headings and preserve page frontmatter", () => {
  const content = `---
type: "concept"
title: "Business Entity"
created: "2026-08-07"
updated: "2026-08-07"
tags: []
related: []
sources: ["source-1"]
covers: ["page-1"]
summary: "Entity"
---

# Business Entity

## Details

Original details.

\`\`\`markdown
## Details
This is an example, not a section.
\`\`\`

## History

Original history.
`
  assert.deepEqual(listWikiPageSections(content).map((section) => section.heading), ["Details", "History"])
  assert.equal(readWikiPageSection(content, "details").content.includes("Original details."), true)

  const changed = applyWikiPageSectionChanges(content, [
    { operation: "replace_section", heading: "Details", content: "Updated details." },
    { operation: "append_to_section", heading: "History", content: "A new event." },
    { operation: "upsert_section", heading: "Operations", level: 3, content: "Operational guidance." },
  ])
  assert.match(changed.content, /^---\ntype: "concept"/)
  assert.match(changed.content, /## Details\n\nUpdated details\./)
  assert.doesNotMatch(changed.content, /Original details\./)
  assert.match(changed.content, /## History[\s\S]*Original history\.[\s\S]*A new event\./)
  assert.match(changed.content, /### Operations\n\nOperational guidance\./)
})

test("incremental section removal rejects missing and duplicate headings", () => {
  const removed = applyWikiPageSectionChanges("# Page\n\n## Remove Me\n\nOld.\n\n## Keep Me\n\nKeep.\n", [
    { operation: "remove_section", heading: "Remove Me" },
  ])
  assert.doesNotMatch(removed.content, /Remove Me|Old\./)
  assert.match(removed.content, /## Keep Me\n\nKeep\./)
  assert.throws(
    () => applyWikiPageSectionChanges("# Page\n", [{ operation: "replace_section", heading: "Missing", content: "New." }]),
    (error) => error.code === "WIKI_SECTION_NOT_FOUND",
  )
  assert.throws(
    () => applyWikiPageSectionChanges("# Page\n\n## Same\n\nOne.\n\n## Same\n\nTwo.\n", [{ operation: "replace_section", heading: "Same", content: "New." }]),
    (error) => error.code === "WIKI_SECTION_AMBIGUOUS",
  )
})
