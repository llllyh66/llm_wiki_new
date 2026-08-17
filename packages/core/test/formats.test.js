import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import JSZip from "jszip"
import { LlmWikiCore } from "../src/index.js"
import { parseManagedSource } from "../src/parser.js"

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
  const batch = await fixture.core.getBatch({ task_id: imported.task_id })
  const rowEvidence = batch.evidence_catalog.find((entry) => entry.quote.includes("| id | string |"))
  assert.ok(rowEvidence)
  assert.equal(rowEvidence.context_quotes.includes("| Name | Type |"), true)
  assert.deepEqual(rowEvidence.context.table_headers, ["Name", "Type"])
})

test("materialized source extension controls parsing instead of display_name", async (t) => {
  const fixture = await formatFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const html = path.join(fixture.incoming, "real.html")
  await writeFile(html, "<h1>Real HTML</h1><script>alert(1)</script><p>Safe body</p>")
  const importedHtml = await fixture.core.importFiles({ files: [{ path: html, display_name: "spoof.md" }] })
  assert.equal(importedHtml.rejected.length, 0)
  const htmlDocument = await managedDocument(fixture.workspace, importedHtml.sources[0].content_hash)
  assert.equal(htmlDocument.mediaType, "text/html")
  assert.equal(JSON.stringify(htmlDocument).includes("alert(1)"), false)

  const markdown = path.join(fixture.incoming, "real.md")
  await writeFile(markdown, "# Real Markdown\n\n<script>literal markdown</script>")
  const importedMarkdown = await fixture.core.importFiles({ files: [{ path: markdown, display_name: "spoof.html" }] })
  assert.equal(importedMarkdown.rejected.length, 0)
  const markdownDocument = await managedDocument(fixture.workspace, importedMarkdown.sources[0].content_hash)
  assert.equal(markdownDocument.mediaType, "text/markdown")
})

test("byte-identical files with different real media types keep separate parser results", async (t) => {
  const fixture = await formatFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const content = "<h1>Shared bytes</h1><script>alert(1)</script><p>Safe body</p>"
  const markdown = path.join(fixture.incoming, "shared.md")
  const html = path.join(fixture.incoming, "shared.html")
  await Promise.all([writeFile(markdown, content), writeFile(html, content)])

  const markdownImport = await fixture.core.importFiles({ files: [{ path: markdown }] })
  const htmlImport = await fixture.core.importFiles({ files: [{ path: html }] })
  const repeatedHtmlImport = await fixture.core.importFiles({ files: [{ path: html }] })
  const markdownSource = markdownImport.sources[0]
  const htmlSource = htmlImport.sources[0]

  assert.equal(markdownSource.content_hash, htmlSource.content_hash)
  assert.notEqual(markdownSource.source_id, htmlSource.source_id)
  assert.equal(htmlImport.accepted.length, 1)
  assert.equal(repeatedHtmlImport.duplicates.length, 1)
  assert.equal(repeatedHtmlImport.sources[0].source_id, htmlSource.source_id)

  const markdownDocument = await documentForManagedPath(fixture.workspace, markdownSource.managed_path)
  const htmlDocument = await documentForManagedPath(fixture.workspace, htmlSource.managed_path)
  assert.equal(markdownDocument.mediaType, "text/markdown")
  assert.equal(htmlDocument.mediaType, "text/html")
  assert.equal(JSON.stringify(markdownDocument).includes("alert(1)"), true)
  assert.equal(JSON.stringify(htmlDocument).includes("alert(1)"), false)
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
  const returnedSpreadsheetChunk = batch.chunks.find((chunk) => chunk.chunkId === spreadsheetChunk.chunkId)
  assert.equal(returnedSpreadsheetChunk.source_ref_templates.length, 1)
  assert.deepEqual(returnedSpreadsheetChunk.source_ref_templates[0].locator, {
    headingPath: returnedSpreadsheetChunk.headingPath,
    startOffset: returnedSpreadsheetChunk.startOffset,
    endOffset: returnedSpreadsheetChunk.endOffset,
    sheetName: "Sales & Forecast",
    cellRange: "A1:E3",
  })
  const rowEvidence = batch.evidence_catalog.find((entry) => entry.quote.includes("Widget \\| Pro"))
  assert.ok(rowEvidence)
  assert.equal(rowEvidence.context_quotes.includes("| Row | A | B | C | D | E |"), true)
  assert.deepEqual(rowEvidence.context.table_headers, ["Row", "A", "B", "C", "D", "E"])
  const analysis = spreadsheetAnalysis(imported.task_id, batch.batch_id, {
    ...returnedSpreadsheetChunk.source_ref_templates[0],
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
    (error) => error.code === "INVALID_SOURCE_REF"
      && error.details.allowed_cell_ranges.includes("A1:E3"),
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

  const smallHint = await fixture.core.getBatch({ task_id: imported.task_id, worker_id: "large-structure-worker", max_chars: 1_000 })
  const normal = await fixture.core.getBatch({ task_id: imported.task_id, worker_id: "large-structure-worker" })
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
  assert.equal(retrieval.corpus.indexed_documents > 100, true)
  assert.equal(retrieval.corpus.truncated, false)
  assert.equal(retrieval.channel_status.feature_hash.mode, "feature-hash-fallback")
  assert.equal(Buffer.byteLength(JSON.stringify(retrieval)) < 20_000, true)
})

test("long block chunks retain piece-level source locators", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-locator-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = path.join(root, "locator-fixture.md")
  const source = `${"word ".repeat(2_500)}\n`
  await writeFile(sourcePath, source)
  const parsed = await parseManagedSource(sourcePath, "source-locator-test", "text/markdown", { maxChunkChars: 1_000 })
  const chunks = parsed.chunks.filter((chunk) => chunk.blockKinds.includes("paragraph"))
  assert.equal(chunks.length > 1, true)
  assert.equal(new Set(chunks.map((chunk) => `${chunk.startOffset}:${chunk.endOffset}`)).size, chunks.length)
  for (const chunk of chunks) {
    assert.equal(chunk.endOffset > chunk.startOffset, true)
    assert.equal(source.slice(chunk.startOffset, chunk.endOffset).includes(chunk.text), true)
  }
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(chunks[index - 1].startOffset < chunks[index].startOffset, true)
  }
})

test("parser and task batching never split a supplementary Unicode character", async (t) => {
  const fixture = await formatFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  const parserSource = `${"a".repeat(299)}😀${"b".repeat(900)}`
  const parserPath = path.join(fixture.incoming, "unicode-parser.md")
  await writeFile(parserPath, parserSource)
  const parsed = await parseManagedSource(parserPath, "source-unicode-parser", "text/markdown", { maxChunkChars: 500 })
  assert.equal(reconstructCoveredSource(parsed.chunks, parserSource), parserSource)
  assert.equal(parsed.chunks.every((chunk) => !hasUnpairedSurrogate(chunk.text)), true)

  const tinyPath = path.join(fixture.incoming, "unicode-tiny.md")
  await writeFile(tinyPath, "😀a")
  const tiny = await parseManagedSource(tinyPath, "source-unicode-tiny", "text/markdown", { maxChunkChars: 1 })
  assert.equal(reconstructCoveredSource(tiny.chunks, "😀a"), "😀a")
  assert.equal(tiny.chunks.every((chunk) => !hasUnpairedSurrogate(chunk.text)), true)

  const taskSource = `${"x".repeat(1_799)}😀${"y".repeat(3_500)}`
  const taskPath = path.join(fixture.incoming, "unicode-task.md")
  await writeFile(taskPath, taskSource)
  const imported = await fixture.core.importFiles({ files: [{ path: taskPath }] })
  const batches = JSON.parse(await readFile(path.join(fixture.workspace, ".llm-wiki", "tasks", imported.task_id, "batches.json"), "utf8"))
  const taskChunks = batches.flatMap((batch) => batch.chunks)
  assert.equal(taskChunks.every((chunk) => !hasUnpairedSurrogate(chunk.text)), true)
  assert.equal(reconstructCoveredSource(taskChunks, taskSource), taskSource)
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

test("PDF pages without a usable text layer fall back to OCR", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-pdf-ocr-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, "scan.pdf")
  await writeFile(source, minimalPdf(""))
  const parsed = await parseManagedSource(source, "source-pdf-ocr", "application/pdf", {
    ocrRecognize: async (_image, context) => ({ text: `Scanned agreement page ${context.pageNumber}`, confidence: 93 }),
  })
  assert.match(parsed.markdown, /Scanned agreement page 1/)
  assert.equal(parsed.document.metadata.ocrPages[0].pageNumber, 1)
  assert.equal(parsed.document.metadata.ocrPages[0].confidence, 93)
  assert.equal(parsed.chunks.some((chunk) => chunk.pageNumber === 1), true)
})

test("PowerPoint slides retain native text, tables, slide locators, and OCR embedded images", async (t) => {
  const fixture = await formatFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const nativeSource = path.join(fixture.incoming, "quarterly.pptx")
  await writeFile(nativeSource, await powerpointFixture())
  const imported = await fixture.core.importFiles({ files: [{ path: nativeSource }] })
  assert.equal(imported.rejected.length, 0)
  const document = await managedDocument(fixture.workspace, imported.sources[0].content_hash)
  assert.equal(document.title, "quarterly")
  assert.equal(document.mediaType, "application/vnd.openxmlformats-officedocument.presentationml.presentation")
  assert.equal(document.metadata.slideCount, 1)
  assert.equal(document.metadata.macrosExecuted, false)
  assert.equal(document.blocks.some((block) => block.kind === "paragraph" && block.text.includes("Revenue increased")), true)
  const table = document.blocks.find((block) => block.kind === "table")
  assert.deepEqual(table.headers, ["Region", "Revenue"])
  assert.deepEqual(table.rows[0], ["North", "42"])
  const chunks = await managedChunks(fixture.workspace, imported.sources[0].content_hash)
  assert.equal(chunks.some((chunk) => chunk.slideNumber === 1), true)
  const batch = await fixture.core.getBatch({ task_id: imported.task_id })
  const slideChunk = batch.chunks.find((chunk) => chunk.slideNumber === 1)
  assert.equal(slideChunk.source_ref_templates[0].locator.slide, 1)

  const imageSource = path.join(fixture.incoming, "scanned-chart.pptx")
  await writeFile(imageSource, await powerpointFixture({ embeddedImage: Buffer.from("mock image") }))
  const parsed = await parseManagedSource(
    imageSource,
    "source-powerpoint-ocr",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    {
      ocrRecognize: async (_image, context) => ({
        text: `OCR chart for slide ${context.slideNumber}`,
        confidence: 97,
      }),
    },
  )
  assert.match(parsed.markdown, /OCR chart for slide 1/)
  assert.equal(parsed.document.metadata.ocrImageCount, 1)
  assert.equal(parsed.document.metadata.slides[0].ocrImages[0].confidence, 97)
})

test("standalone images normalize injected OCR text and metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-image-ocr-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, "receipt.png")
  await writeFile(source, Buffer.from("mock image"))
  const parsed = await parseManagedSource(source, "source-image-ocr", "image/png", {
    ocrRecognize: async () => ({ text: "Invoice number 4827", confidence: 96.5 }),
  })
  assert.equal(parsed.document.title, "receipt")
  assert.equal(parsed.document.metadata.extractionMethod, "ocr")
  assert.equal(parsed.document.metadata.confidence, 96.5)
  assert.equal(parsed.chunks.some((chunk) => /Invoice number 4827/.test(chunk.text)), true)
})

test("bundled OCR worker recognizes a real packaged image without injection", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-real-ocr-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { createCanvas } = await import("@napi-rs/canvas")
  const canvas = createCanvas(1_000, 260)
  const context = canvas.getContext("2d")
  context.fillStyle = "white"
  context.fillRect(0, 0, 1_000, 260)
  context.fillStyle = "black"
  context.font = "bold 96px sans-serif"
  context.fillText("INVOICE 4827", 50, 165)
  const source = path.join(root, "invoice.png")
  await writeFile(source, canvas.toBuffer("image/png"))
  const parsed = await parseManagedSource(source, "source-real-ocr", "image/png")
  assert.match(parsed.markdown, /4827/)
  assert.equal(parsed.document.metadata.extractionMethod, "ocr")
})

test("image dimension bombs are rejected from headers before decoder allocation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-image-bomb-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, "bomb.png")
  const header = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write("IHDR", 12, "ascii")
  header.writeUInt32BE(100_000, 16)
  header.writeUInt32BE(100_000, 20)
  await writeFile(source, header)
  await assert.rejects(
    () => parseManagedSource(source, "source-image-bomb", "image/png"),
    (error) => error.code === "SOURCE_PARSE_FAILED" && /dimension|pixel/.test(error.message),
  )
})

async function managedDocument(workspace, hash) {
  return JSON.parse(await readFile(path.join(workspace, ".llm-wiki", "sources", "objects", hash, "extracted", "document.json"), "utf8"))
}

async function managedChunks(workspace, hash) {
  return JSON.parse(await readFile(path.join(workspace, ".llm-wiki", "sources", "objects", hash, "extracted", "chunks.json"), "utf8"))
}

async function documentForManagedPath(workspace, managedPath) {
  return JSON.parse(await readFile(path.join(workspace, path.dirname(managedPath), "extracted", "document.json"), "utf8"))
}

function reconstructCoveredSource(chunks, source) {
  const ordered = [...chunks].sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset)
  let cursor = 0
  let reconstructed = ""
  for (const chunk of ordered) {
    assert.equal(chunk.startOffset <= cursor, true, `gap before source offset ${chunk.startOffset}`)
    if (chunk.endOffset <= cursor) continue
    reconstructed += source.slice(cursor, chunk.endOffset)
    cursor = chunk.endOffset
  }
  assert.equal(cursor, source.length)
  return reconstructed
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
      index += 1
    } else if (code >= 0xDC00 && code <= 0xDFFF) return true
  }
  return false
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

async function powerpointFixture(options = {}) {
  const zip = new JSZip()
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree>
        <p:sp><p:txBody><a:p><a:r><a:t>Quarterly Plan</a:t></a:r></a:p><a:p><a:r><a:t>Revenue increased &amp; costs stayed flat.</a:t></a:r></a:p></p:txBody></p:sp>
        <a:tbl>
          <a:tr><a:tc><a:txBody><a:p><a:r><a:t>Region</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
          <a:tr><a:tc><a:txBody><a:p><a:r><a:t>North</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>42</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
        </a:tbl>
      </p:spTree></p:cSld>
    </p:sld>`)
  if (options.embeddedImage) {
    zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
        <Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="https://example.invalid/chart.png"/>
      </Relationships>`)
    zip.file("ppt/media/image1.png", options.embeddedImage)
  }
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
