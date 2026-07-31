#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LlmWikiCore } from "../../core/src/index.js"
import { HeadlessToolRouter } from "./tools.js"

function parseWorkspace(argv) {
  const index = argv.indexOf("--workspace")
  if (index < 0) return process.cwd()
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error("--workspace requires a directory argument")
  return value
}

async function main() {
  const core = await LlmWikiCore.open(parseWorkspace(process.argv.slice(2)))
  const router = new HeadlessToolRouter(core)
  const server = new Server({ name: "llm-wiki", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: router.listTools() }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => router.callMcp(request.params.name, request.params.arguments ?? {}))
  await server.connect(new StdioServerTransport())
  process.stderr.write("[llm-wiki-mcp] headless workspace ready\n")
}

main().catch((error) => {
  process.stderr.write(`[llm-wiki-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
