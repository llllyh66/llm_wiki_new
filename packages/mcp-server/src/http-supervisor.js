#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_PORT = 31_982
const MAX_RESTART_DELAY_MS = 5_000

function parseArgs(argv) {
  const read = (name, fallback) => {
    const index = argv.indexOf(name)
    if (index < 0) return fallback
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
    return value
  }
  const workspaceRoot = path.resolve(read("--workspace", process.cwd()))
  const port = Number(read("--port", process.env.LLM_WIKI_MCP_HTTP_PORT || DEFAULT_PORT))
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) throw new Error("--port must be an integer from 1024 to 65535")
  return { workspaceRoot, port }
}

function log(event, details = {}) {
  process.stderr.write(`${JSON.stringify({ component: "llm-wiki-mcp-supervisor", event, pid: process.pid, ...details })}\n`)
}

async function main() {
  const { workspaceRoot, port } = parseArgs(process.argv.slice(2))
  const runDir = path.join(workspaceRoot, ".llm-wiki", "run")
  const pidFile = path.join(runDir, `mcp-http-${port}.pid`)
  const workerPath = fileURLToPath(new URL("./http-worker.js", import.meta.url))
  const buildInfo = await readFile(fileURLToPath(new URL("./build-info.json", import.meta.url)), "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => null)
  await mkdir(runDir, { recursive: true })
  await writeFile(pidFile, `${JSON.stringify({ pid: process.pid, workspace: workspaceRoot, port, startedAt: new Date().toISOString() })}\n`, "utf8")

  let stopping = false
  let worker = null
  let consecutiveFailures = 0
  const stop = (signal) => {
    if (stopping) return
    stopping = true
    log("shutdown-requested", { signal, workerPid: worker?.pid ?? null })
    if (worker && worker.exitCode === null) worker.kill("SIGTERM")
  }
  process.once("SIGTERM", () => stop("SIGTERM"))
  process.once("SIGINT", () => stop("SIGINT"))

  try {
    while (!stopping) {
      const startedAt = Date.now()
      let becameReady = false
      worker = spawn(process.execPath, [workerPath, "--workspace", workspaceRoot, "--port", String(port)], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          LLM_WIKI_MCP_SUPERVISOR_PID: String(process.pid),
          LLM_WIKI_MCP_SUPERVISOR_BUILD: buildInfo?.builtAt || "unknown",
        },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      })
      worker.on("message", (message) => {
        if (message?.type === "ready") becameReady = true
      })
      log("worker-start", { workerPid: worker.pid, port, restartCount: consecutiveFailures })
      const outcome = await new Promise((resolve) => {
        worker.once("error", (error) => resolve({ code: null, signal: null, error }))
        worker.once("exit", (code, signal) => resolve({ code, signal }))
      })
      const lifetimeMs = Date.now() - startedAt
      log("worker-exit", {
        workerPid: worker.pid,
        lifetimeMs,
        code: outcome.code,
        signal: outcome.signal,
        ...(outcome.error ? { message: outcome.error.message } : {}),
      })
      worker = null
      if (stopping) break
      if (!becameReady && outcome.code === 78) {
        log("worker-startup-fatal", { code: outcome.code, port })
        stopping = true
        process.exitCode = 78
        break
      }
      consecutiveFailures = lifetimeMs >= 30_000 ? 0 : consecutiveFailures + 1
      const delayMs = Math.min(MAX_RESTART_DELAY_MS, 250 * (2 ** Math.min(consecutiveFailures - 1, 5)))
      log("worker-retry", { delayMs, restartCount: consecutiveFailures })
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  } finally {
    await unlink(pidFile).catch(() => {})
  }
}

main().catch((error) => {
  log("fatal", { message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})
