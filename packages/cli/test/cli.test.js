import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"

test("CLI initializes and migrates a legacy source tree without semantic generation", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-cli-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const legacy = path.join(workspace, "raw", "sources")
  await mkdir(legacy, { recursive: true })
  await writeFile(path.join(legacy, "legacy.md"), "# Legacy Source\n\nImported by the migration bridge.\n")
  const cli = fileURLToPath(new URL("../src/index.js", import.meta.url))
  const initialized = run(cli, ["init", "--workspace", workspace])
  assert.equal(initialized.status, 0, initialized.stderr)
  assert.equal(JSON.parse(initialized.stdout).workspace_initialized, true)
  const migrated = run(cli, ["migrate-legacy", "raw/sources", "--workspace", workspace])
  assert.equal(migrated.status, 0, migrated.stderr)
  const result = JSON.parse(migrated.stdout)
  assert.equal(result.accepted.length, 1)
  assert.equal(result.status, "prepared")
})

test("CLI rejects missing option values before opening a workspace", () => {
  const cli = fileURLToPath(new URL("../src/index.js", import.meta.url))
  for (const option of ["--workspace", "--domain-schema"]) {
    const result = run(cli, ["init", option])
    assert.equal(result.status, 1)
    assert.match(JSON.parse(result.stderr).error.message, new RegExp(`${option} requires a value`))
  }
})

test("CLI legacy migration includes XLSX workbooks", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-cli-xlsx-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const legacy = path.join(workspace, "raw", "sources")
  await mkdir(legacy, { recursive: true })
  await writeFile(path.join(legacy, "legacy.xlsx"), await minimalXlsx())
  const cli = fileURLToPath(new URL("../src/index.js", import.meta.url))
  const migrated = run(cli, ["migrate-legacy", "raw/sources", "--workspace", workspace])
  assert.equal(migrated.status, 0, migrated.stderr)
  const result = JSON.parse(migrated.stdout)
  assert.equal(result.accepted.length, 1)
  assert.equal(result.sources[0].display_name, "legacy.xlsx")
})

function run(cli, args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" })
}

async function minimalXlsx() {
  const zip = new JSZip()
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`)
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>`)
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Legacy spreadsheet</t></is></c></row>
    </sheetData></worksheet>`)
  return zip.generateAsync({ type: "nodebuffer" })
}
