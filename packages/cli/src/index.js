#!/usr/bin/env node
import { LlmWikiCore, asLlmWikiError } from "@llm-wiki/core"

const argv = process.argv.slice(2)

try {
  const workspace = takeOption(argv, "--workspace") ?? process.cwd()
  const domainSchemaPath = takeOption(argv, "--domain-schema")
  const command = argv.shift()
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
  else {
    process.stderr.write("Usage: llm-wiki <init|import|status|lint|abort|delete> [arguments] [--workspace DIR] [--domain-schema DIRECTORY]\n")
    process.exitCode = 2
    process.exit()
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: asLlmWikiError(error).toJSON() }, null, 2)}\n`)
  process.exitCode = 1
}

function takeOption(args, name) {
  const indexes = args.flatMap((value, index) => value === name ? [index] : [])
  if (indexes.length > 1) throw new Error(`${name} may only be specified once.`)
  if (indexes.length === 0) return undefined
  const index = indexes[0]
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`)
  args.splice(index, 2)
  return value
}
