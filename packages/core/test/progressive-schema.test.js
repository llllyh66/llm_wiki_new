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
  await mkdir(path.join(schema, "Customer_Domain"), { recursive: true })
  await mkdir(workspace, { recursive: true })
  await mkdir(incoming, { recursive: true })
  await writeFile(path.join(schema, "all_domains.json"), JSON.stringify({ domains: [{ key: "Customer_Domain", name: "客户域" }] }))
  await writeFile(path.join(schema, "Customer_Domain", "Customer_Domain_domain.json"), JSON.stringify({ items: [{ key: "customer_management", name: "客户管理" }] }))
  const abe = { bes: [{ id: "individual_customer", name: "个人客户", properties: { arbitrary: ["JSON", 1, true] } }] }
  await writeFile(path.join(schema, "Customer_Domain", "customer_management.json"), JSON.stringify(abe))
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
  assert.deepEqual(domains.navigation.available_domain_folders, ["Customer_Domain"])
  assert.deepEqual(domains.content, { domains: [{ key: "Customer_Domain", name: "客户域" }] })
  const domain = await core.getDomainSchema({ task_id: imported.task_id, level: "domain", domain_folder: "Customer_Domain" })
  assert.deepEqual(domain.navigation.available_abe_files, ["customer_management.json"])
  const disclosedAbe = await core.getDomainSchema({ task_id: imported.task_id, level: "abe", domain_folder: "Customer_Domain", abe_file: "customer_management.json" })
  assert.deepEqual(disclosedAbe.content, abe)
  assert.equal(disclosedAbe.full_file_exposed, true)
  assert.equal(disclosedAbe.classification_scaffold.domain.key, "Customer_Domain")
  assert.equal(disclosedAbe.classification_scaffold.abe.file, "Customer_Domain/customer_management.json")
  assert.deepEqual(disclosedAbe.be_pointer_hints[0], { pointer: "/bes/0", key: "individual_customer", name: "个人客户" })
  assert.equal(disclosedAbe.json_pointer_contract.uri_fragment_syntax_accepted, "#/objectField/arrayIndex")

  const batch = await core.getBatch({ task_id: imported.task_id, worker_id: "progressive-test-worker" })
  assert.equal(batch.workspace_context.domain_schema.mode, PROGRESSIVE_SCHEMA_MODE)
  assert.equal(batch.workspace_context.domain_schema_disclosure.fullFileExposure, true)
  assert.equal(batch.workspace_context.domain_schema_auto_selection, undefined)
  assert.equal(batch.workspace_context.domain_schema_pagination, undefined)
  assert.equal(batch.extraction_hot_path.schema_call_required, true)
  const chunk = batch.chunks[0]
  await assert.rejects(
    () => core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      worker_id: batch.worker_id,
      idempotency_key: "progressive-invalid-pointer-v1",
      analysis: {
        ...batch.analysis_scaffold,
        entities: [{
          localId: "invalid-customer",
          name: "张三",
          sourceRefs: [0],
          schemaClassification: {
            status: "classified",
            domain: { key: "Customer_Domain" },
            abe: { file: "customer_management.json" },
            be: { key: "not_in_schema", pointer: "/bes/999" },
          },
        }],
      },
    }),
    (error) => error?.code === "INVALID_DOMAIN_ANALYSIS"
      && error.details?.classification_hints?.[0]?.selected_abe_file === "Customer_Domain/customer_management.json"
      && error.details.classification_hints[0].be_pointer_hints[0].pointer === "/bes/0",
  )
  const committed = await core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    worker_id: batch.worker_id,
    idempotency_key: "progressive-analysis-v2",
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
          domain: { key: "customer_domain", name: "客户域" },
          abe: { key: "customermanagement", name: "客户管理", file: "missing-old-name.json" },
          be: { key: "individual_customer", pointer: "#/bes/individual_customer" },
        },
      }],
      unresolvedQuestions: [{ reason: "等待后续批次核对别名。" }],
    },
  })
  assert.equal(committed.accepted, true)
  assert.equal(committed.domain_validation.schema_mode, PROGRESSIVE_SCHEMA_MODE)
  assert.equal(committed.normalized_unresolved_questions, 1)
  const persistedAnalysisPath = path.join(workspace, ".llm-wiki", "tasks", imported.task_id, "analysis", `${batch.batch_id}.json`)
  const persistedAnalysis = JSON.parse(await readFile(persistedAnalysisPath, "utf8"))
  assert.equal(persistedAnalysis.unresolvedQuestions[0], "等待后续批次核对别名。")
  assert.deepEqual(persistedAnalysis.entities[0].schemaClassification.domain.key, "Customer_Domain")
  assert.equal(persistedAnalysis.entities[0].schemaClassification.abe.file, "Customer_Domain/customer_management.json")
  assert.deepEqual(persistedAnalysis.entities[0].schemaClassification.be, {
    key: "individual_customer",
    pointer: "/bes/0",
    name: "个人客户",
  })
  const legacyAnalysis = structuredClone(persistedAnalysis)
  legacyAnalysis.entities[0].schemaClassification.status = "unresolved"
  legacyAnalysis.entities[0].schemaClassification.be = { pointer: "/bes/0" }
  await writeFile(persistedAnalysisPath, JSON.stringify(legacyAnalysis))

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
  assert.match(page, /schema_classification_kinds: \["entity"\]/u)
  assert.doesNotMatch(page, /domain_type_(?:kinds|ids|names)/u)

  const manifestView = await core.getPagePlanContext({
    task_id: imported.task_id,
    writer_id: "wiki-writer-1",
    view: "manifest",
    cursor: 0,
    max_chars: 40_000,
  })
  const shardView = await core.getPagePlanContext(manifestView.draft_manifest.draft_actions[0].arguments)
  assert.equal(shardView.page_requirements[0].domain_classifications[0].be.key, "individual_customer")
  const staged = await core.stagePageDrafts({
    ...shardView.next_action.arguments,
    patches: shardView.page_requirements.map((requirement) => ({
      ...requirement.patch_scaffold,
      content: `# ${requirement.title}\n\n客户实体。`,
      summary: "客户实体。",
    })),
    idempotency_key: "progressive-stage-with-be-v1",
  })
  const stagedStatus = await core.getStagedPageDrafts(staged.next_action.arguments)
  const committedPages = await core.commitPages({
    ...stagedStatus.next_action.arguments,
    idempotency_key: "progressive-commit-with-be-v1",
  })
  const completedProjection = await core.commitPages({
    ...committedPages.next_action.arguments,
    idempotency_key: "progressive-final-ack-with-be-v1",
  })
  assert.equal(completedProjection.projection_complete, true)
  const wikiPage = await readFile(path.join(workspace, shardView.page_requirements[0].patch_scaffold.path), "utf8")
  assert.match(wikiPage, /schema_be_keys: \["individual_customer"\]/u)
  assert.match(wikiPage, /schema_be_names: \["个人客户"\]/u)
  assert.match(wikiPage, /schema_classification_status: "unresolved"/u)
  assert.doesNotMatch(wikiPage, /schema_be_(?:keys|names): \[\]/u)
  assert.match(wikiPage, /BE：个人客户/u)
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

test("fixed-object and inline Domain Schemas are rejected; only progressive directories are accepted", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-progressive-only-"))
  const workspace = path.join(root, "workspace")
  const incoming = path.join(root, "incoming")
  await mkdir(workspace, { recursive: true })
  await mkdir(incoming, { recursive: true })
  const source = path.join(incoming, "record.md")
  await writeFile(source, "# Record\n\nOne grounded fact.\n")
  const fixedSchema = path.join(root, "fixed-schema.json")
  await writeFile(fixedSchema, JSON.stringify({ formatVersion: "1.0", entityTypes: [] }))
  const core = await LlmWikiCore.open(workspace)
  t.after(() => rm(root, { recursive: true, force: true }))

  await assert.rejects(
    () => core.importFiles({ files: [{ path: source }], options: { domain_schema: { formatVersion: "1.0", entityTypes: [] } } }),
    (error) => error?.code === "INVALID_DOMAIN_SCHEMA" && /Inline domain Schemas are not supported/u.test(error.message),
  )
  await assert.rejects(
    () => core.importFiles({ files: [{ path: source }], options: { domain_schema_path: fixedSchema } }),
    (error) => error?.code === "INVALID_DOMAIN_SCHEMA" && /must point to a regular progressive-directory-v2/u.test(error.message),
  )
})

test("progressive disclosure rejects removed fixed-object query arguments", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-progressive-arguments-"))
  const workspace = path.join(root, "workspace")
  const schema = path.join(root, "schema")
  const incoming = path.join(root, "incoming")
  await mkdir(path.join(schema, "customer"), { recursive: true })
  await mkdir(workspace, { recursive: true })
  await mkdir(incoming, { recursive: true })
  await writeFile(path.join(schema, "all_domains.json"), JSON.stringify({ domains: [{ key: "customer" }] }))
  await writeFile(path.join(schema, "customer", "customer_domain.json"), JSON.stringify({ abes: [{ key: "customer_management" }] }))
  await writeFile(path.join(schema, "customer", "customer_management.json"), JSON.stringify({ businessEntities: [{ id: "customer" }] }))
  const source = path.join(incoming, "record.md")
  await writeFile(source, "# Customer\n\nOne customer.\n")
  const core = await LlmWikiCore.open(workspace)
  t.after(() => rm(root, { recursive: true, force: true }))

  const imported = await core.importFiles({ files: [{ path: source }], options: { domain_schema_path: schema } })
  await assert.rejects(
    () => core.getDomainSchema({ task_id: imported.task_id, mode: "search", queries: ["customer"] }),
    (error) => error?.code === "INVALID_INPUT" && /Fixed-object Domain Schema arguments were removed/u.test(error.message),
  )
})

test("workspace default Domain Schema is the llm-wiki.domain-schema directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-progressive-default-"))
  const workspace = path.join(root, "workspace")
  const schema = path.join(workspace, "llm-wiki.domain-schema")
  const incoming = path.join(root, "incoming")
  await mkdir(path.join(schema, "business"), { recursive: true })
  await mkdir(incoming, { recursive: true })
  await writeFile(path.join(schema, "all_domains.json"), JSON.stringify({ domains: [{ key: "business" }] }))
  await writeFile(path.join(schema, "business", "business_domain.json"), JSON.stringify({ abes: [{ key: "operations" }] }))
  await writeFile(path.join(schema, "business", "operations.json"), JSON.stringify({ businessEntities: [{ id: "operation" }] }))
  const source = path.join(incoming, "record.md")
  await writeFile(source, "# Operation\n\nOne operation.\n")
  const core = await LlmWikiCore.open(workspace)
  t.after(() => rm(root, { recursive: true, force: true }))

  const imported = await core.importFiles({ files: [{ path: source }] })
  assert.equal(imported.domain_schema.schema_mode, PROGRESSIVE_SCHEMA_MODE)
})
