#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, EmptyResultSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LlmWikiCore } from "../../core/src/index.js"
import { HeadlessToolRouter } from "./tools.js"

const STDIO_MAX_BUFFER_BYTES = 32 * 1024 * 1024
const DEFAULT_MCP_KEEPALIVE_MS = 5 * 60_000
const DEFAULT_MCP_KEEPALIVE_TIMEOUT_MS = 30_000

// Keep the production default at five minutes (the documented host-compatibility
// setting), while allowing the STDIO smoke test and operators to use a shorter
// interval without editing the bundled server. The lower bound prevents an
// accidental environment setting from turning the server into a ping loop.
function readMilliseconds(name, fallback, { minimum = 1_000, maximum = 30 * 60_000 } = {}) {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)))
}

const MCP_KEEPALIVE_MS = readMilliseconds("LLM_WIKI_MCP_KEEPALIVE_MS", DEFAULT_MCP_KEEPALIVE_MS)
const MCP_KEEPALIVE_TIMEOUT_MS = readMilliseconds(
  "LLM_WIKI_MCP_KEEPALIVE_TIMEOUT_MS",
  DEFAULT_MCP_KEEPALIVE_TIMEOUT_MS,
  { minimum: 250, maximum: 60_000 },
)

function log(event, details = {}) {
  try {
    process.stderr.write(`${JSON.stringify({ component: "llm-wiki-mcp", event, ...details })}\n`)
  } catch {
    // Diagnostics must never turn a handled tool error into a rejected MCP
    // request or terminate the STDIO server (for example after stderr closes).
  }
}

// Tool-level failures are converted to structured results by HeadlessToolRouter
// and never reach these process-level hooks. An unexpected exception/rejection
// means the process may no longer be safe to keep serving; once main() has
// attached its transport, it performs a graceful close so the host can restart
// a clean MCP process instead of leaving a silent zombie behind.
let requestFatalShutdown = null
process.on("uncaughtException", (error) => {
  log("uncaught-exception", { message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
  if (requestFatalShutdown) requestFatalShutdown("uncaught-exception", error)
})
process.on("unhandledRejection", (reason) => {
  log("unhandled-rejection", { message: reason instanceof Error ? reason.message : String(reason) })
  process.exitCode = 1
  if (requestFatalShutdown) requestFatalShutdown("unhandled-rejection", reason)
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
  transport.onerror = (error) => log("transport-error", { message: error instanceof Error ? error.message : String(error) })
  transport.onclose = () => log("transport-closed")
  server.onerror = (error) => log("protocol-error", { message: error instanceof Error ? error.message : String(error) })
  let resolveClosed
  const closed = new Promise((resolve) => { resolveClosed = resolve })
  let closeRequested = false
  const requestShutdown = (reason, error) => {
    if (closeRequested) return
    closeRequested = true
    log("shutdown-requested", {
      reason,
      ...(error ? { message: error instanceof Error ? error.message : String(error) } : {}),
    })
    // StdioServerTransport from the SDK does not listen for stdin end/close.
    // Closing the protocol explicitly prevents a dead child process from
    // remaining around after Claude has dropped its pipe.
    Promise.resolve(server.close())
      .catch((closeError) => log("shutdown-error", { message: closeError instanceof Error ? closeError.message : String(closeError) }))
      .finally(() => resolveClosed())
  }
  requestFatalShutdown = requestShutdown
  server.onclose = () => {
    log("server-closed")
    resolveClosed()
  }

  // The SDK's StdioServerTransport handles data and error events, but not the
  // lifecycle events that indicate the other end of a pipe has disappeared.
  // Watch the streams at the adapter boundary so we never leave a silent,
  // unusable MCP process behind.
  const onStdinEnd = () => requestShutdown("stdin-closed")
  const onStdinError = (error) => requestShutdown("stdin-error", error)
  const onStdoutClose = () => requestShutdown("stdout-closed")
  const onStdoutError = (error) => requestShutdown("stdout-error", error)
  process.stdin.once("end", onStdinEnd)
  process.stdin.once("close", onStdinEnd)
  process.stdin.once("error", onStdinError)
  process.stdout.once("close", onStdoutClose)
  process.stdout.once("error", onStdoutError)

  let keepalive
  try {
    await server.connect(transport)
    log("ready", {
      workspace: ".",
      tools: router.listTools().length,
      maxBufferBytes: STDIO_MAX_BUFFER_BYTES,
      keepaliveMs: MCP_KEEPALIVE_MS,
      keepaliveTimeoutMs: MCP_KEEPALIVE_TIMEOUT_MS,
    })
    // Some hosts (including long-running Agent worker sessions) enforce an
    // idle timeout outside the MCP process. Keep the protocol session active
    // while extraction continues without tool calls. Use the public request API
    // with an explicit timeout instead of Server#ping(), whose SDK default is
    // 60 seconds. A missing pong is diagnostic only; it must not poison the
    // session or leave an in-flight request that blocks future heartbeats.
    let keepaliveBusy = false
    keepalive = setInterval(() => {
      if (keepaliveBusy || closeRequested || !server.transport) return
      keepaliveBusy = true
      const startedAt = Date.now()
      Promise.resolve(server.request(
        { method: "ping" },
        EmptyResultSchema,
        { timeout: MCP_KEEPALIVE_TIMEOUT_MS, maxTotalTimeout: MCP_KEEPALIVE_TIMEOUT_MS },
      ))
        .then(() => log("keepalive", { status: "ok", durationMs: Date.now() - startedAt }))
        .catch((error) => log("keepalive", {
          status: "failed",
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => { keepaliveBusy = false })
    }, MCP_KEEPALIVE_MS)
    await closed
  } finally {
    if (keepalive) clearInterval(keepalive)
    process.stdin.off("end", onStdinEnd)
    process.stdin.off("close", onStdinEnd)
    process.stdin.off("error", onStdinError)
    process.stdout.off("close", onStdoutClose)
    process.stdout.off("error", onStdoutError)
    requestFatalShutdown = null
  }
}

main().catch((error) => {
  log("fatal", { message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})
