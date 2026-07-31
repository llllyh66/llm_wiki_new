import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

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

function run(cli, args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" })
}
