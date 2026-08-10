#!/usr/bin/env node
import { LlmWikiCore, asLlmWikiError } from "@llm-wiki/core"
import { readdir } from "node:fs/promises"
import path from "node:path"

const argv = process.argv.slice(2)
const workspaceFlag = argv.indexOf("--workspace")
const workspace = workspaceFlag >= 0 ? argv[workspaceFlag + 1] : process.cwd()
if (workspaceFlag >= 0) argv.splice(workspaceFlag, 2)
const domainSchemaFlag = argv.indexOf("--domain-schema")
const domainSchemaPath = domainSchemaFlag >= 0 ? argv[domainSchemaFlag + 1] : undefined
if (domainSchemaFlag >= 0) argv.splice(domainSchemaFlag, 2)
const command = argv.shift()

try {
  const core = await LlmWikiCore.open(workspace)
  let result
  if (command === "init") result = await core.init()
  else if (command === "import") {
    if (argv.length === 0) throw new Error("Usage: llm-wiki import <file...> [--domain-schema DIRECTORY]")
    result = await core.importFiles({ files: argv.map((file) => ({ path: file })), options: { domain_schema_path: domainSchemaPath } })
  } else if (command === "status") {
    result = argv[0] ? await core.status({ task_id: argv[0] }) : await core.listTasks()
  } else if (command === "lint") result = await core.lint()
  else if (command === "abort") result = await core.abort({ task_id: argv[0], reason: "Cancelled from CLI" })
  else if (command === "delete") {
    const scope = argv[0]
    const confirmed = argv.includes("--confirm-delete-knowledge-base")
    result = await core.deleteKnowledgeBase({ scope, confirmation: confirmed ? "DELETE KNOWLEDGE BASE" : "" })
  }
  else if (command === "migrate-legacy") {
    const legacyRoot = path.resolve(core.workspaceRoot, argv[0] || "raw/sources")
    const files = await collectSupportedFiles(legacyRoot)
    if (files.length === 0) throw new Error(`No supported legacy sources found under ${legacyRoot}`)
    result = await core.importFiles({ files: files.map((file) => ({ path: file })), options: { domain_schema_path: domainSchemaPath } })
  }
  else {
    process.stderr.write("Usage: llm-wiki <init|import|status|lint|abort|delete|migrate-legacy> [arguments] [--workspace DIR] [--domain-schema DIRECTORY]\n")
    process.exitCode = 2
    process.exit()
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: asLlmWikiError(error).toJSON() }, null, 2)}\n`)
  process.exitCode = 1
}

async function collectSupportedFiles(root) {
  const supported = new Set([".md", ".markdown", ".txt", ".html", ".htm", ".docx", ".pdf"])
  const files = []
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile() && supported.has(path.extname(entry.name).toLowerCase())) files.push(absolute)
    }
  }
  await walk(root)
  return files
}
