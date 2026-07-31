#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LlmWikiCore } from "../../core/src/index.js"
import { HeadlessToolRouter } from "./tools.js"

const STDIO_MAX_BUFFER_BYTES = 32 * 1024 * 1024

function log(event, details = {}) {
  process.stderr.write(`${JSON.stringify({ component: "llm-wiki-mcp", event, ...details })}\n`)
}

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
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const startedAt = Date.now()
    const result = await router.callMcp(request.params.name, request.params.arguments ?? {})
    const structured = result.structuredContent
    const status = result._meta?.llmWikiStatus === "rejected" || structured?.accepted === false ? "rejected" : "ok"
    log("tool-call", { name: request.params.name, status, durationMs: Date.now() - startedAt })
    return result
  })
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: STDIO_MAX_BUFFER_BYTES })
  transport.onerror = (error) => log("transport-error", { message: error.message })
  transport.onclose = () => log("transport-closed")
  server.onerror = (error) => log("protocol-error", { message: error.message })
  let resolveClosed
  const closed = new Promise((resolve) => { resolveClosed = resolve })
  server.onclose = () => {
    log("server-closed")
    resolveClosed()
  }
  await server.connect(transport)
  log("ready", { workspace: ".", tools: router.listTools().length, maxBufferBytes: STDIO_MAX_BUFFER_BYTES })
  await closed
}

main().catch((error) => {
  log("fatal", { message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})
