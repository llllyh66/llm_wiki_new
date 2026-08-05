#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LlmWikiCore } from "../../core/src/index.js"
import { HeadlessToolRouter } from "./tools.js"

const STDIO_MAX_BUFFER_BYTES = 32 * 1024 * 1024

function log(event, details = {}) {
  try {
    process.stderr.write(`${JSON.stringify({ component: "llm-wiki-mcp", event, ...details })}\n`)
  } catch {
    // Diagnostics must never turn a handled tool error into a rejected MCP
    // request or terminate the STDIO server (for example after stderr closes).
  }
}

// A rejected promise outside the tool router must not terminate the long-lived
// STDIO process. Tool-level failures are converted to structured results by
// HeadlessToolRouter; these handlers cover SDK/transport callbacks and late
// filesystem promises that would otherwise make Claude report "disconnect".
process.on("uncaughtException", (error) => {
  log("uncaught-exception", { message: error instanceof Error ? error.message : String(error) })
})
process.on("unhandledRejection", (reason) => {
  log("unhandled-rejection", { message: reason instanceof Error ? reason.message : String(reason) })
})

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
    const name = request?.params?.name ?? "<invalid-tool>"
    try {
      const result = await router.callMcp(name, request?.params?.arguments ?? {})
      const structured = result.structuredContent
      const status = result._meta?.llmWikiStatus === "rejected" || structured?.accepted === false ? "rejected" : "ok"
      log("tool-call", { name, status, durationMs: Date.now() - startedAt })
      return result
    } catch (error) {
      // This is a last-resort SDK boundary guard. Normally callMcp already
      // catches and serializes every Core error; returning a protocol-safe
      // result here prevents one unexpected handler failure from closing MCP.
      log("tool-handler-error", { name, message: error instanceof Error ? error.message : String(error) })
      return {
        content: [{ type: "text", text: JSON.stringify({
          ok: false,
          accepted: false,
          rejected: true,
          error: { code: "MCP_HANDLER_ERROR", message: "Tool handler failed; retry the operation.", retryable: true },
          next_action: { tool: "llm_wiki_list_tasks", arguments: {} },
          mcp_connection_usable: true,
        }) }],
      }
    }
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
