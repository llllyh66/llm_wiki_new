import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import JSZip from "jszip"
import { LlmWikiCore } from "../src/index.js"

async function formatFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-formats-"))
  const workspace = path.join(root, "workspace")
  const incoming = path.join(root, "incoming")
  await Promise.all([mkdir(workspace), mkdir(incoming)])
  return { root, workspace, incoming, core: await LlmWikiCore.open(workspace) }
}

test("HTML headings and tables normalize into structured blocks", async (t) => {
  const fixture = await formatFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = path.join(fixture.incoming, "dictionary.html")
  await writeFile(source, `<!doctype html><html><body><h1>Data Dictionary</h1><p>Fields used by the product.</p><table><tr><th>Name</th><th>Type</th></tr><tr><td>id</td><td>string</td></tr></table><script>ignore()</script></body></html>`)
  const imported = await fixture.core.importFiles({ files: [{ path: source }] })
  const document = await managedDocument(fixture.workspace, imported.sources[0].content_hash)
  assert.equal(document.title, "Data Dictionary")
  assert.equal(document.blocks.some((block) => block.kind === "table" && block.headers[0] === "Name" && block.rows[0][0] === "id"), true)
  assert.equal(JSON.stringify(document).includes("ignore()"), false)
})

test("DOCX tables retain headers, rows, and merge metadata without executing active content", async (t) => {
  const fixture = await formatFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const zip = new JSZip()
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Customer Model</w:t></w:r></w:p>
      <w:p><w:r><w:t>Structured customer data.</w:t></w:r></w:p>
      <w:tbl>
        <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Field</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>id</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>string</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    </w:body></w:document>`)
  const source = path.join(fixture.incoming, "customer.docx")
  await writeFile(source, await zip.generateAsync({ type: "nodebuffer" }))
  const imported = await fixture.core.importFiles({ files: [{ path: source }] })
  const document = await managedDocument(fixture.workspace, imported.sources[0].content_hash)
  const table = document.blocks.find((block) => block.kind === "table")
  assert.equal(document.title, "Customer Model")
  assert.equal(table.headers[0], "Field")
  assert.deepEqual(table.rows[0].slice(0, 2), ["id", "string"])
  assert.deepEqual(table.mergedCells[0], { row: 0, column: 0, columnSpan: 2 })
})

test("XLSX worksheets retain ranges, cached formulas, merges, hidden cells, and dates", async (t) => {
  const fixture = await formatFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = path.join(fixture.incoming, "sales.xlsx")
  await writeFile(source, await xlsxFixture())
  const imported = await fixture.core.importFiles({ files: [{ path: source }] })
  assert.equal(imported.rejected.length, 0)
  const document = await managedDocument(fixture.workspace, imported.sources[0].content_hash)
  const table = document.blocks.find((block) => block.kind === "table")
  assert.equal(document.title, "sales")
  assert.equal(document.mediaType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  assert.equal(document.metadata.formulasExecuted, false)
  assert.deepEqual(document.metadata.sheets.map((sheet) => sheet.name), ["Sales & Forecast", "Hidden Notes"])
  assert.equal(table.sheetName, "Sales & Forecast")
  assert.equal(table.cellRange, "A1:E3")
  assert.deepEqual(table.headers, ["Row", "A", "B", "C", "D", "E"])
  assert.deepEqual(table.rows[1].slice(0, 4), ["2", "Widget | Pro", "42", "84"])
  assert.equal(table.rows[2][2], "2024-01-01")
  assert.deepEqual(table.mergedCells[0], {
    range: "D1:E1",
    startRow: 1,
    endRow: 1,
    startColumn: "D",
    endColumn: "E",
    rowSpan: 1,
    columnSpan: 2,
  })
  assert.deepEqual(table.hiddenRows, [3])
  assert.deepEqual(table.hiddenColumns, ["E"])
  assert.deepEqual(table.formulas[0], {
    cell: "C2",
    formula: "B2*2",
    cachedValue: "84",
  })
  const chunks = await managedChunks(fixture.workspace, imported.sources[0].content_hash)
  const spreadsheetChunk = chunks.find((chunk) => chunk.sheetName === "Sales & Forecast")
  assert.equal(spreadsheetChunk.cellRange, "A1:E3")
  assert.equal(spreadsheetChunk.structuredData[0].formulas[0].cachedValue, "84")
  const batch = await fixture.core.getBatch({ task_id: imported.task_id })
  const analysis = spreadsheetAnalysis(imported.task_id, batch.batch_id, {
    sourceId: imported.sources[0].source_id,
    chunkId: spreadsheetChunk.chunkId,
    locator: { sheetName: spreadsheetChunk.sheetName, cellRange: spreadsheetChunk.cellRange },
  })
  await assert.rejects(
    fixture.core.commitAnalysis({
      task_id: imported.task_id,
      batch_id: batch.batch_id,
      analysis: spreadsheetAnalysis(imported.task_id, batch.batch_id, {
        ...analysis.sourceRefs[0],
        locator: { sheetName: spreadsheetChunk.sheetName, cellRange: "A1:A999" },
      }),
      idempotency_key: "xlsx-invalid-locator",
    }),
    (error) => error.code === "INVALID_SOURCE_REF",
  )
  const committed = await fixture.core.commitAnalysis({
    task_id: imported.task_id,
    batch_id: batch.batch_id,
    analysis,
    idempotency_key: "xlsx-valid-locator",
  })
  assert.equal(committed.accepted, true)
})

test("XLSX tables are split into bounded A1 ranges and corrupt workbooks are rejected", async (t) => {
  const fixture = await formatFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = path.join(fixture.incoming, "large.xlsx")
  await writeFile(source, await xlsxFixture({ rowCount: 600 }))
  const imported = await fixture.core.importFiles({ files: [{ path: source }] })
  const document = await managedDocument(fixture.workspace, imported.sources[0].content_hash)
  const tables = document.blocks.filter((block) => block.kind === "table" && block.sheetName === "Sales & Forecast")
  assert.equal(tables.length > 1, true)
  assert.equal(tables.every((table) => /^[A-Z]+\d+:[A-Z]+\d+$/.test(table.cellRange)), true)
  assert.equal(tables.every((table) => table.markdown.length <= 8_000), true)

  const corrupt = path.join(fixture.incoming, "corrupt.xlsx")
  await writeFile(corrupt, "not a zip archive")
  await assert.rejects(
    fixture.core.importFiles({ files: [{ path: corrupt }] }),
    (error) => error.code === "SOURCE_IMPORT_FAILED" && error.details.rejected[0].code === "SOURCE_PARSE_FAILED",
  )
})

test("very large Markdown tables and code blocks produce complete payload-bounded batches", async (t) => {
  const fixture = await formatFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = path.join(fixture.incoming, "large-structures.md")
  const tableRows = Array.from({ length: 5_000 }, (_, index) => `| metric-${index} | ${"value ".repeat(8)}${index} |`)
  const largeCode = "x".repeat(300_000)
  await writeFile(source, `# Large structures\n\n| Name | Value |\n| --- | --- |\n${tableRows.join("\n")}\n\n\`\`\`text\n${largeCode}\n\`\`\`\n`)
  const imported = await fixture.core.importFiles({
    files: [{ path: source }],
    options: { max_batch_chars: 12_000 },
  })
  const batches = JSON.parse(await readFile(path.join(fixture.workspace, ".llm-wiki", "tasks", imported.task_id, "batches.json"), "utf8"))
  assert.equal(batches.length > 10, true)
  assert.equal(batches.every((batch) => batch.charCount <= 12_000), true)
  assert.equal(batches.every((batch) => batch.payloadBytes <= 128 * 1024), true)
  assert.equal(batches.flatMap((batch) => batch.chunks).every((chunk) => chunk.text.length <= 8_000), true)

  const smallHint = await fixture.core.getBatch({ task_id: imported.task_id, max_chars: 1_000 })
  const normal = await fixture.core.getBatch({ task_id: imported.task_id })
  assert.equal(smallHint.batch_limits.complete, true)
  assert.equal(smallHint.batch_id, normal.batch_id)
  assert.deepEqual(smallHint.chunks, normal.chunks)
  assert.equal(Buffer.byteLength(JSON.stringify(smallHint)) < 512 * 1024, true)

  const configPath = path.join(fixture.workspace, ".llm-wiki", "config.json")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.retrieval.maxDocuments = 100
  await writeFile(configPath, JSON.stringify(config))
  const retrieval = await fixture.core.retrieveContext({
    task_id: imported.task_id,
    batch_id: normal.batch_id,
    queries: ["metric-0"],
    channels: ["bm25", "embedding", "wiki"],
    max_chars: 10_000,
  })
  assert.equal(retrieval.fusion, "rrf")
  assert.equal(retrieval.corpus.max_documents, 100)
  assert.equal(retrieval.corpus.truncated, true)
  assert.equal(retrieval.channel_status.embedding.mode, "feature-hash-fallback")
  assert.equal(Buffer.byteLength(JSON.stringify(retrieval)) < 20_000, true)
})

test("PDF text is normalized page by page with traceable page numbers", async (t) => {
  const fixture = await formatFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = path.join(fixture.incoming, "brief.pdf")
  await writeFile(source, minimalPdf("Hello PDF Knowledge"))
  const imported = await fixture.core.importFiles({ files: [{ path: source }] })
  const chunks = JSON.parse(await readFile(path.join(fixture.workspace, ".llm-wiki", "sources", "objects", imported.sources[0].content_hash, "extracted", "chunks.json"), "utf8"))
  assert.equal(chunks[0].pageNumber, 1)
  assert.match(chunks[0].text, /Hello PDF Knowledge/)
})

async function managedDocument(workspace, hash) {
  return JSON.parse(await readFile(path.join(workspace, ".llm-wiki", "sources", "objects", hash, "extracted", "document.json"), "utf8"))
}

async function managedChunks(workspace, hash) {
  return JSON.parse(await readFile(path.join(workspace, ".llm-wiki", "sources", "objects", hash, "extracted", "chunks.json"), "utf8"))
}

function spreadsheetAnalysis(taskId, batchId, sourceRef) {
  return {
    schemaVersion: 1,
    taskId,
    batchId,
    sourceRefs: [sourceRef],
    entities: [],
    concepts: [],
    claims: [],
    relations: [],
    contradictions: [],
    candidatePages: [],
    reviewItems: [],
    batchSummary: "Spreadsheet locator validation fixture.",
    unresolvedQuestions: [],
  }
}

async function xlsxFixture(options = {}) {
  const rowCount = options.rowCount ?? 3
  const zip = new JSZip()
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets>
        <sheet name="Sales &amp; Forecast" sheetId="1" r:id="rId1"/>
        <sheet name="Hidden Notes" sheetId="2" state="hidden" r:id="rId2"/>
      </sheets>
    </workbook>`)
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
      <Relationship Id="external" TargetMode="External" Target="https://example.invalid/data"/>
    </Relationships>`)
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <si><t>Name</t></si><si><t>Amount</t></si><si><t>Total</t></si>
      <si><t>Group</t></si><si><t>Widget | Pro</t></si><si><t>Notes</t></si>
    </sst>`)
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>
    </styleSheet>`)
  const rows = [
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>`,
    `<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2"><v>42</v></c><c r="C2"><f>B2*2</f><v>84</v></c><c r="D2" t="inlineStr"><is><t>Retail</t></is></c><c r="E2" t="b"><v>1</v></c></row>`,
    `<row r="3" hidden="1"><c r="A3" t="s"><v>5</v></c><c r="B3" s="1"><v>45292</v></c></row>`,
  ]
  for (let row = 4; row <= rowCount; row += 1) {
    rows.push(`<row r="${row}"><c r="A${row}" t="inlineStr"><is><t>Item ${row}</t></is></c><c r="B${row}"><v>${row}</v></c><c r="C${row}"><f>B${row}*2</f><v>${row * 2}</v></c></row>`)
  }
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <cols><col min="5" max="5" hidden="1"/></cols>
      <sheetData>${rows.join("")}</sheetData>
      <mergeCells count="1"><mergeCell ref="D1:E1"/></mergeCells>
    </worksheet>`)
  zip.file("xl/worksheets/sheet2.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Internal note</t></is></c></row>
    </sheetData></worksheet>`)
  return zip.generateAsync({ type: "nodebuffer" })
}

function minimalPdf(text) {
  const escaped = text.replace(/[()\\]/g, "\\$&")
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let body = "%PDF-1.4\n"
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}
