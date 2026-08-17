import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { LlmWikiCore } from "../src/index.js"
import { prepareWikiPageContent } from "../src/wiki-page.js"

function classifiedPage(pagePath, title, classification, schemaId = "schema-service-v1") {
  return prepareWikiPageContent({
    patchId: `patch-${title}`,
    path: pagePath,
    operation: "create",
    title,
    pageKind: pagePath.includes("/concepts/") ? "concept" : "entity",
    content: `# ${title}\n\nGrounded page.`,
    summary: `${title} summary.`,
    sourceRefs: [{ sourceId: "source-1" }],
    domainSchemaId: schemaId,
    domainSchemaVersion: "2",
    domainClassifications: [{
      kind: pagePath.includes("/concepts/") ? "concept" : "entity",
      typeId: classification.be.key,
      typeName: classification.be.name,
      schemaId: `${schemaId}-snapshot`,
      schemaVersion: "2",
      schemaMode: "progressive-directory-v2",
      status: classification.status ?? "classified",
      domain: classification.domain,
      abe: classification.abe,
      be: classification.be,
    }],
  }, "", "2026-08-12")
}

test("Domain page query inspects classifications and searches them with stable pagination", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-domain-query-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const core = await LlmWikiCore.open(root)
  await core.init()
  await mkdir(path.join(root, "wiki", "entities"), { recursive: true })
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true })

  const common = {
    domain: { key: "Service_Domain", name: "服务域" },
    abe: { key: "mobility_management", name: "移动性管理" },
  }
  await writeFile(path.join(root, "wiki", "entities", "n26.md"), classifiedPage(
    "wiki/entities/n26.md",
    "N26",
    { ...common, be: { key: "n26_interface", name: "N26接口" } },
  ))
  await writeFile(path.join(root, "wiki", "concepts", "resident-bit.md"), classifiedPage(
    "wiki/concepts/resident-bit.md",
    "驻留比",
    { ...common, be: { key: "resident_ratio", name: "驻留比" }, status: "unresolved" },
  ))
  await writeFile(path.join(root, "wiki", "entities", "resource.md"), classifiedPage(
    "wiki/entities/resource.md",
    "资源",
    {
      domain: { key: "Resource_Domain", name: "资源域" },
      abe: { key: "resource_management", name: "资源管理" },
      be: { key: "resource", name: "资源" },
    },
    "schema-resource-v1",
  ))

  const inspected = await core.queryDomainPages({ action: "inspect", paths: ["wiki/entities/n26.md"] })
  assert.equal(inspected.pages[0].classified, true)
  assert.equal(inspected.pages[0].domain_schema.id, "schema-service-v1")
  assert.equal(inspected.pages[0].domain_schema.snapshot_hash, "schema-service-v1-snapshot")
  assert.deepEqual(inspected.pages[0].classifications[0].domain, { key: "Service_Domain", name: "服务域" })
  assert.equal(inspected.pages[0].classifications[0].path, "Service_Domain/mobility_management/n26_interface")

  const first = await core.queryDomainPages({
    action: "search",
    filters: { domain_schema_id: "schema-service-v1", domain: "服务域" },
    limit: 1,
  })
  assert.equal(first.total_matches, 2)
  assert.equal(first.returned, 1)
  assert.equal(first.next_cursor, 1)
  assert.equal(first.next_action.arguments.cursor, 1)

  const second = await core.queryDomainPages(first.next_action.arguments)
  assert.equal(second.returned, 1)
  assert.equal(second.next_cursor, null)
  assert.deepEqual([...first.pages, ...second.pages].map((page) => page.path), [
    "wiki/concepts/resident-bit.md",
    "wiki/entities/n26.md",
  ])

  const subtree = await core.queryDomainPages({
    action: "search",
    filters: { classification_path_prefix: "service_domain/mobility_management", status: "unresolved", kind: "concept" },
  })
  assert.equal(subtree.total_matches, 1)
  assert.equal(subtree.pages[0].title, "驻留比")

  const resource = await core.queryDomainPages({ action: "search", filters: { be: "资源" } })
  assert.equal(resource.total_matches, 1)
  assert.equal(resource.pages[0].domain_schema.id, "schema-resource-v1")
})

