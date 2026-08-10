import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { LlmWikiCore } from "../src/index.js"
import { PROGRESSIVE_SCHEMA_MODE } from "../src/schema-bundle.js"
import { prepareWikiPageContent } from "../src/wiki-page.js"

test("progressive directory Schema snapshots files and discloses Domain, ABE, then full BE JSON", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-progressive-"))
  const workspace = path.join(root, "workspace")
  const schema = path.join(root, "schema")
  const incoming = path.join(root, "incoming")
  await mkdir(path.join(schema, "customer"), { recursive: true })
  await mkdir(workspace, { recursive: true })
  await mkdir(incoming, { recursive: true })
  await writeFile(path.join(schema, "all_domains.json"), JSON.stringify({ domains: [{ key: "customer", name: "客户域" }] }))
  await writeFile(path.join(schema, "customer", "customer_domain.json"), JSON.stringify({ items: [{ key: "customer_management", name: "客户管理" }] }))
  const abe = { businessEntities: [{ id: "individual_customer", name: "个人客户", properties: { arbitrary: ["JSON", 1, true] } }] }
  await writeFile(path.join(schema, "customer", "customer_management.json"), JSON.stringify(abe))
  const source = path.join(incoming, "record.md")
  await writeFile(source, "# 客户\n\n张三是个人客户。\n")
  const core = await LlmWikiCore.open(workspace)
  t.after(() => rm(root, { recursive: true, force: true }))

  const imported = await core.importFiles({ files: [{ path: source }], options: { domain_schema_path: schema } })
  assert.equal(imported.domain_schema.schema_mode, PROGRESSIVE_SCHEMA_MODE)
  const taskManifestPath = path.join(workspace, ".llm-wiki", "tasks", imported.task_id, "domain-schema.json")
  const manifest = JSON.parse(await readFile(taskManifestPath, "utf8"))
  assert.equal(manifest.mode, PROGRESSIVE_SCHEMA_MODE)

  const domains = await core.getDomainSchema({ task_id: imported.task_id, level: "domains" })
  assert.deepEqual(domains.navigation.available_domain_folders, ["customer"])
  assert.deepEqual(domains.content, { domains: [{ key: "customer", name: "客户域" }] })
  const domain = await core.getDomainSchema({ task_id: imported.task_id, level: "domain", domain_folder: "customer" })
  assert.deepEqual(domain.navigation.available_abe_files, ["customer_management.json"])
  const disclosedAbe = await core.getDomainSchema({ task_id: imported.task_id, level: "abe", domain_folder: "customer", abe_file: "customer_management.json" })
  assert.deepEqual(disclosedAbe.content, abe)
  assert.equal(disclosedAbe.full_file_exposed, true)

  const batch = await core.getBatch({ task_id: imported.task_id, worker_id: "progressive-test-worker" })
  assert.equal(batch.workspace_context.domain_schema.mode, PROGRESSIVE_SCHEMA_MODE)
  assert.equal(batch.workspace_context.domain_schema_pagination.full_file_exposure, true)
  const chunk = batch.chunks[0]
  const committed = await core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    worker_id: batch.worker_id,
    idempotency_key: "progressive-analysis-v1",
    analysis: {
      ...batch.analysis_scaffold,
      sourceRefs: [{ sourceId: chunk.sourceId, chunkId: chunk.chunkId, quote: "张三是个人客户。", locator: { headingPath: chunk.headingPath, startOffset: chunk.startOffset, endOffset: chunk.endOffset } }],
      entities: [{
        localId: "customer-1",
        name: "张三",
        sourceRefs: [0],
        schemaClassification: {
          status: "classified",
          confidence: 0.9,
          domain: { key: "customer", name: "客户域" },
          abe: { key: "customer_management", name: "客户管理", file: "customer_management.json" },
          be: { key: "individual_customer", name: "个人客户", pointer: "/businessEntities/0" },
        },
      }],
    },
  })
  assert.equal(committed.accepted, true)
  assert.equal(committed.domain_validation.schema_mode, PROGRESSIVE_SCHEMA_MODE)

  const page = prepareWikiPageContent({
    path: "wiki/entities/zhang-san.md",
    operation: "create",
    title: "张三",
    pageKind: "entity",
    content: "# 张三\n\n客户实体。",
    sourceRefs: [{ sourceId: chunk.sourceId, chunkId: chunk.chunkId }],
    domainClassifications: [{
      kind: "entity",
      typeId: "individual_customer",
      typeName: "个人客户",
      schemaId: imported.domain_schema.schema_id,
      schemaVersion: "2",
      schemaMode: PROGRESSIVE_SCHEMA_MODE,
      status: "classified",
      domain: { key: "customer", name: "客户域" },
      abe: { key: "customer_management", name: "客户管理" },
      be: { key: "individual_customer", name: "个人客户" },
    }],
  })
  assert.match(page, /Domain：客户域.*ABE：客户管理.*BE：个人客户/u)
  assert.match(page, /schema_layout: "progressive-directory-v2"/u)
})

test("progressive disclosure accepts an ABE larger than the old 80 KiB guard and keeps it whole", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-progressive-large-"))
  const workspace = path.join(root, "workspace")
  const schema = path.join(root, "schema")
  const incoming = path.join(root, "incoming")
  await mkdir(path.join(schema, "customer"), { recursive: true })
  await mkdir(workspace, { recursive: true })
  await mkdir(incoming, { recursive: true })
  await writeFile(path.join(schema, "all_domains.json"), JSON.stringify({ domains: [{ key: "customer" }] }))
  await writeFile(path.join(schema, "customer", "customer_domain.json"), JSON.stringify({ abes: [{ key: "customer_management" }] }))
  const largeDescription = "完整 ABE 内容。".repeat(12_000)
  const abe = { businessEntities: [{ id: "individual_customer", description: largeDescription }] }
  const abePath = path.join(schema, "customer", "customer_management.json")
  await writeFile(abePath, JSON.stringify(abe))
  assert.equal((await readFile(abePath, "utf8")).length > 80 * 1024, true)
  const source = path.join(incoming, "record.md")
  await writeFile(source, "# 客户\n\n张三是个人客户。\n")
  const core = await LlmWikiCore.open(workspace)
  t.after(() => rm(root, { recursive: true, force: true }))

  const imported = await core.importFiles({ files: [{ path: source }], options: { domain_schema_path: schema } })
  const disclosed = await core.getDomainSchema({
    task_id: imported.task_id,
    level: "abe",
    domain_folder: "customer",
    abe_file: "customer_management.json",
  })
  assert.equal(disclosed.full_file_exposed, true)
  assert.deepEqual(disclosed.content, abe)
  assert.equal(disclosed.bytes > 80 * 1024, true)
})
