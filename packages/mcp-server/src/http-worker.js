#!/usr/bin/env node
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { EmptyResultSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { createWriteStream } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { LlmWikiCore } from "@llm-wiki/core"
import { BoundedEventStore } from "./event-store.js"
import { createProtocolServer, readInteger } from "./protocol-server.js"
import { HeadlessToolRouter } from "./tools.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 31_982
const DEFAULT_HTTP_KEEPALIVE_MS = 10_000
const DEFAULT_PROTOCOL_KEEPALIVE_MS = 60_000
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 15_000

let runtimeLogStream = null
let runtimeDegraded = false

function parseArgs(argv) {
  const read = (name, fallback) => {
    const index = argv.indexOf(name)
    if (index < 0) return fallback
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
    return value
  }
  const workspaceRoot = path.resolve(read("--workspace", process.cwd()))
  const host = read("--host", process.env.LLM_WIKI_MCP_HTTP_HOST || DEFAULT_HOST)
  const port = Number(read("--port", process.env.LLM_WIKI_MCP_HTTP_PORT || DEFAULT_PORT))
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("The project MCP daemon must bind to a loopback host.")
  }
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) throw new Error("--port must be an integer from 1024 to 65535")
  return { workspaceRoot, host, port }
}

function runtimeMemory() {
  try {
    const memory = process.memoryUsage()
    return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external }
  } catch {
    return {}
  }
}

function log(event, details = {}) {
  try {
    const line = `${JSON.stringify({
      component: "llm-wiki-mcp-http",
      event,
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1_000),
      ...runtimeMemory(),
      ...details,
    })}\n`
    process.stderr.write(line)
    if (runtimeLogStream && !runtimeLogStream.destroyed) runtimeLogStream.write(line)
  } catch {
    // Diagnostics must not break the MCP transport.
  }
}

async function configureRuntimeLog(workspaceRoot) {
  const target = path.join(workspaceRoot, ".llm-wiki", "logs", "mcp-runtime.jsonl")
  await mkdir(path.dirname(target), { recursive: true })
  runtimeLogStream = createWriteStream(target, { flags: "a", encoding: "utf8" })
  runtimeLogStream.on("error", (error) => {
    runtimeLogStream = null
    log("runtime-log-error", { path: target, message: error instanceof Error ? error.message : String(error) })
  })
  return target
}

async function loadBuildInfo() {
  try {
    return JSON.parse(await readFile(fileURLToPath(new URL("./build-info.json", import.meta.url)), "utf8"))
  } catch {
    return { gitCommit: "unknown", builtAt: null, source: "unbuilt" }
  }
}

async function main() {
  const { workspaceRoot, host, port } = parseArgs(process.argv.slice(2))
  const runtimeLogPath = await configureRuntimeLog(workspaceRoot)
  const buildInfo = await loadBuildInfo()
  const core = await LlmWikiCore.open(workspaceRoot)
  const router = new HeadlessToolRouter(core)
  const sessions = new Map()
  const httpKeepaliveMs = readInteger("LLM_WIKI_MCP_HTTP_KEEPALIVE_MS", DEFAULT_HTTP_KEEPALIVE_MS, { minimum: 1_000, maximum: 60_000 })
  const protocolKeepaliveMs = readInteger("LLM_WIKI_MCP_KEEPALIVE_MS", DEFAULT_PROTOCOL_KEEPALIVE_MS, { minimum: 1_000, maximum: 30 * 60_000 })
  const keepaliveTimeoutMs = readInteger("LLM_WIKI_MCP_KEEPALIVE_TIMEOUT_MS", DEFAULT_KEEPALIVE_TIMEOUT_MS, { minimum: 250, maximum: 60_000 })
  const app = createMcpExpressApp({ host })
  app.disable("x-powered-by")

  const cleanupSession = async (sessionId, reason) => {
    const session = sessions.get(sessionId)
    if (!session) return
    sessions.delete(sessionId)
    clearInterval(session.keepalive)
    log("session-closed", { sessionId, reason, sessions: sessions.size })
    try { await session.server.close() } catch (error) {
      log("session-close-error", { sessionId, message: error instanceof Error ? error.message : String(error) })
    }
  }

  const createSession = async () => {
    let sessionId = null
    const protocolServer = createProtocolServer(router, { log, isDegraded: () => runtimeDegraded })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      eventStore: new BoundedEventStore(),
      retryInterval: 1_000,
      keepAliveMs: httpKeepaliveMs,
      onsessioninitialized: (initializedSessionId) => {
        sessionId = initializedSessionId
        sessions.set(initializedSessionId, record)
        log("session-ready", { sessionId: initializedSessionId, sessions: sessions.size })
      },
      onsessionclosed: (closedSessionId) => cleanupSession(closedSessionId, "client-delete"),
    })
    const record = { transport, server: protocolServer, keepalive: null, keepaliveBusy: false }
    transport.onerror = (error) => log("transport-error", { sessionId, message: error instanceof Error ? error.message : String(error) })
    transport.onclose = () => {
      if (sessionId && sessions.has(sessionId)) void cleanupSession(sessionId, "transport-close")
    }
    protocolServer.onerror = (error) => log("protocol-error", { sessionId, message: error instanceof Error ? error.message : String(error) })
    await protocolServer.connect(transport)
    record.keepalive = setInterval(() => {
      if (!sessionId || record.keepaliveBusy || !sessions.has(sessionId) || !protocolServer.transport) return
      record.keepaliveBusy = true
      const startedAt = Date.now()
      Promise.resolve(protocolServer.request(
        { method: "ping" },
        EmptyResultSchema,
        { timeout: keepaliveTimeoutMs, maxTotalTimeout: keepaliveTimeoutMs },
      ))
        .then(() => log("keepalive", { transport: "http", sessionId, status: "ok", durationMs: Date.now() - startedAt }))
        .catch((error) => log("keepalive", {
          transport: "http",
          sessionId,
          status: "failed",
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => { record.keepaliveBusy = false })
    }, protocolKeepaliveMs)
    return record
  }

  const resolveSession = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"]
    if (typeof sessionId === "string" && sessions.has(sessionId)) return sessions.get(sessionId)
    if (!sessionId && isInitializeRequest(req.body)) return createSession()
    res.status(sessionId ? 404 : 400).json({
      jsonrpc: "2.0",
      error: { code: -32_000, message: sessionId ? "MCP session not found; reconnect and initialize a new session." : "Missing MCP session ID." },
      id: null,
    })
    return null
  }

  app.get("/health", (_req, res) => res.json({
    ok: true,
    service: "llm-wiki-mcp",
    transport: "streamable-http",
    workspace: workspaceRoot,
    port,
    pid: process.pid,
    supervisorPid: Number(process.env.LLM_WIKI_MCP_SUPERVISOR_PID) || null,
    supervisorBuild: process.env.LLM_WIKI_MCP_SUPERVISOR_BUILD || null,
    sessions: sessions.size,
    degraded: runtimeDegraded,
    build: buildInfo,
  }))
  app.post("/mcp", async (req, res) => {
    const session = await resolveSession(req, res)
    if (!session) return
    await session.transport.handleRequest(req, res, req.body)
  })
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"]
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : null
    if (!session) return res.status(404).send("MCP session not found; reconnect and initialize a new session.")
    await session.transport.handleRequest(req, res)
  })
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"]
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : null
    if (!session) return res.status(404).send("MCP session not found.")
    await session.transport.handleRequest(req, res)
  })

  const httpServer = await new Promise((resolve, reject) => {
    const listening = app.listen(port, host, (error) => {
      if (error) reject(error)
      else resolve(listening)
    })
    listening.once("error", reject)
  })
  log("ready", {
    workspace: workspaceRoot,
    host,
    port,
    tools: router.listTools().length,
    httpKeepaliveMs,
    protocolKeepaliveMs,
    keepaliveTimeoutMs,
    build: buildInfo,
    runtimeLogPath,
  })
  process.send?.({ type: "ready", pid: process.pid, port })

  let shuttingDown = false
  const shutdown = async (reason) => {
    if (shuttingDown) return
    shuttingDown = true
    log("shutdown-requested", { reason, sessions: sessions.size })
    await Promise.allSettled([...sessions.keys()].map((sessionId) => cleanupSession(sessionId, reason)))
    await new Promise((resolve) => httpServer.close(() => resolve()))
    runtimeLogStream?.end()
  }
  process.once("SIGTERM", () => { void shutdown("sigterm") })
  process.once("SIGINT", () => { void shutdown("sigint") })
  await new Promise((resolve) => httpServer.once("close", resolve))
}

process.on("unhandledRejection", (reason) => {
  runtimeDegraded = true
  log("unhandled-rejection", { message: reason instanceof Error ? reason.message : String(reason) })
})
process.on("uncaughtException", (error) => {
  log("uncaught-exception", { message: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
process.on("warning", (warning) => log("process-warning", { name: warning?.name, message: warning?.message }))
process.on("exit", (code) => log("process-exit", { code, degraded: runtimeDegraded }))

main().catch((error) => {
  log("fatal", { message: error instanceof Error ? error.message : String(error) })
  process.exitCode = ["EADDRINUSE", "EACCES", "EPERM"].includes(error?.code) ? 78 : 1
})
