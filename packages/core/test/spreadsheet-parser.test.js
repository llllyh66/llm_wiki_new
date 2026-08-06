import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import JSZip from "jszip"
import { LlmWikiCore } from "../src/index.js"
import { normalizeExternalParseResult, spreadsheetRetrievalViewsFromTable } from "../src/spreadsheet-parser.js"

test("enhanced Excel output is normalized into bounded, source-grounded chunks and views", () => {
  const parsed = normalizeExternalParseResult({
    workbook: {
      workbook_id: "wb-1",
      filename: "metrics.xlsx",
      total_sheets: 1,
      total_cells: 4,
      total_formulas: 1,
      named_ranges: [{ name: "KQI", ref_string: "Metrics!A1:B2" }],
      kpi_catalog: [{ label: "Success rate", cell_ref: "Metrics!B2" }],
      dependency_edges: [{ source: "Metrics!B2", target: "Metrics!A2" }],
      errors: [],
    },
    chunks: [{
      chunk_id: "external-1",
      source_uri: "metrics.xlsx#Metrics!A1:B2",
      sheet_name: "Metrics",
      block_type: "table",
      token_count: 30,
      render_text: "Success rate is calculated from successful requests.",
      cells: [
        { address: "A2", value: "Successful requests" },
        { address: "B2", value: "0.98", formula: "=A2/C2" },
      ],
      key_cells: [{ address: "B2", value: "0.98" }],
      named_ranges: ["KQI"],
      dependency_summary: { upstream_refs: ["Metrics!A2"], downstream_refs: [] },
    }],
  }, "metrics.xlsx", { maxChunkChars: 6_000, maxTotalCells: 100 })

  assert.equal(parsed.provider, "enhanced")
  assert.equal(parsed.parser.version, "excel-parser-0.2.1")
  assert.equal(parsed.chunks.length, 1)
  assert.match(parsed.chunks[0].text, /Sheet: Metrics/)
  assert.match(parsed.chunks[0].text, /B2: =A2\/C2/)
  assert.match(parsed.chunks[0].text, /Success rate is calculated/)
  assert.equal(parsed.chunks[0].structuredData[0].cellRange, "A1:B2")
  assert.equal(parsed.chunks[0].retrievalViews.some((view) => view.view === "excel-formula"), true)
  assert.equal(parsed.chunks[0].retrievalViews.some((view) => view.view === "excel-dependency"), true)
  assert.equal(parsed.chunks[0].sourceUri.includes("/Users/"), false)
})

test("native spreadsheet retrieval views include formula and named-range lanes", () => {
  const views = spreadsheetRetrievalViewsFromTable({
    sheetName: "指标",
    cellRange: "A1:C4",
    markdown: "| A | B | C |",
    formulas: [{ cell: "C2", formula: "=A2/B2", cachedValue: "0.9" }],
    namedRanges: ["KQI"],
  })
  assert.deepEqual(views.map((view) => view.view), ["excel-block", "excel-formula", "excel-named-range"])
  assert.match(views[1].content, /C2: =A2\/B2/)
  assert.match(views[2].content, /KQI/)
})

test("pre-Wiki BM25 can retrieve native Excel formula views with the same source locator", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-spreadsheet-retrieval-"))
  const incoming = path.join(root, "incoming")
  const workspace = path.join(root, "workspace")
  await mkdir(incoming)
  await mkdir(workspace)
  t.after(() => rm(root, { recursive: true, force: true }))

  const zip = new JSZip()
  zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Metrics" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>`)
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Success rate</t></is></c><c r="B1" t="inlineStr"><is><t>Formula</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Requests</t></is></c><c r="B2"><f>A2/100</f><v>0.98</v></c></row></sheetData></worksheet>`)
  const source = path.join(incoming, "metrics.xlsx")
  await writeFile(source, await zip.generateAsync({ type: "nodebuffer" }))
  const core = await LlmWikiCore.open(workspace)
  const imported = await core.importFiles({ files: [{ path: source }] })
  const batch = await core.getBatch({ task_id: imported.task_id })
  const result = await core.retrieveContext({ task_id: imported.task_id, batch_id: batch.batch_id, queries: ["Formula dependencies"], channels: ["bm25"], limit: 10 })
  const formulaHit = result.hits.find((hit) => hit.view === "excel-formula")
  assert.ok(formulaHit)
  assert.equal(formulaHit.source_id, imported.sources[0].source_id)
  assert.equal(formulaHit.locator.sheetName, "Metrics")
  assert.equal(formulaHit.locator.cellRange, "A1:B2")
})
