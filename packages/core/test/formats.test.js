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
