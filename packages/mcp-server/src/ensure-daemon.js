#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_PORT = 31_982

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

async function health(port, workspaceRoot) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 750)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    if (!response.ok) return null
    const data = await response.json()
    if (path.resolve(data.workspace || ".") !== workspaceRoot) {
      throw new Error(`Port ${port} is already used by llm-wiki workspace ${data.workspace}. Set LLM_WIKI_MCP_HTTP_PORT to a different port on this device.`)
    }
    return data
  } catch (error) {
    if (error?.message?.includes("already used by llm-wiki workspace")) throw error
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function waitForHealth(port, workspaceRoot, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await health(port, workspaceRoot)
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return null
}

async function waitForStop(port, workspaceRoot, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!await health(port, workspaceRoot)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function localBuildInfo() {
  try {
    return JSON.parse(await readFile(fileURLToPath(new URL("./build-info.json", import.meta.url)), "utf8"))
  } catch {
    return null
  }
}

function sameBuild(running, local) {
  if (!running?.build || !local) return true
  return running.build.packageVersion === local.packageVersion
    && running.build.gitCommit === local.gitCommit
    && running.build.builtAt === local.builtAt
    && running.supervisorBuild === local.builtAt
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function pidIsAlive(pidFile, workspaceRoot, port) {
  try {
    const record = JSON.parse(await readFile(pidFile, "utf8"))
    if (record.workspace !== workspaceRoot || record.port !== port || !Number.isInteger(record.pid)) return false
    process.kill(record.pid, 0)
    return true
  } catch {
    return false
  }
}

async function acquireStartLock(lockFile) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx", 0o600)
      return handle
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const info = await stat(lockFile).catch(() => null)
      if (info && Date.now() - info.mtimeMs < 15_000) return null
      await unlink(lockFile).catch(() => {})
    }
  }
  return null
}

async function main() {
  const { workspaceRoot, port } = parseArgs(process.argv.slice(2))
  const buildInfo = await localBuildInfo()
  const running = await health(port, workspaceRoot)
  const supervisorAlive = processIsAlive(running?.supervisorPid)
  if (running && sameBuild(running, buildInfo) && supervisorAlive) return
  if (running) {
    const targetPid = supervisorAlive ? running.supervisorPid : running.pid
    if (!Number.isInteger(targetPid) || targetPid <= 1) throw new Error(`The llm-wiki MCP daemon on port ${port} has no valid process ID.`)
    process.kill(targetPid, "SIGTERM")
    if (!await waitForStop(port, workspaceRoot)) {
      throw new Error(`Timed out replacing the old llm-wiki MCP build on port ${port}.`)
    }
    if (!await waitForPidExit(targetPid)) {
      throw new Error(`The old llm-wiki MCP process ${targetPid} did not exit.`)
    }
  }

  const runDir = path.join(workspaceRoot, ".llm-wiki", "run")
  const logsDir = path.join(workspaceRoot, ".llm-wiki", "logs")
  const pidFile = path.join(runDir, `mcp-http-${port}.pid`)
  const lockFile = path.join(runDir, `mcp-http-${port}.starting`)
  await mkdir(runDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })

  if (await pidIsAlive(pidFile, workspaceRoot, port)) {
    if (await waitForHealth(port, workspaceRoot)) return
    throw new Error(`The llm-wiki MCP supervisor is alive but port ${port} did not become healthy. Check .llm-wiki/logs/mcp-daemon.log.`)
  }

  const lock = await acquireStartLock(lockFile)
  if (!lock) {
    if (await waitForHealth(port, workspaceRoot)) return
    throw new Error(`Timed out waiting for another client session to start the llm-wiki MCP daemon on port ${port}.`)
  }

  try {
    if (await health(port, workspaceRoot)) return
    const supervisorPath = fileURLToPath(new URL("./http-supervisor.js", import.meta.url))
    const logHandle = await open(path.join(logsDir, "mcp-daemon.log"), "a", 0o600)
    try {
      const child = spawn(process.execPath, [supervisorPath, "--workspace", workspaceRoot, "--port", String(port)], {
        cwd: workspaceRoot,
        detached: true,
        windowsHide: true,
        env: { ...process.env, LLM_WIKI_MCP_HTTP_PORT: String(port) },
        stdio: ["ignore", logHandle.fd, logHandle.fd],
      })
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve)
        child.once("error", reject)
      })
      child.unref()
    } finally {
      await logHandle.close()
    }
    if (!await waitForHealth(port, workspaceRoot)) {
      throw new Error(`Failed to start the llm-wiki MCP daemon on port ${port}. Check .llm-wiki/logs/mcp-daemon.log.`)
    }
  } finally {
    await lock.close()
    await unlink(lockFile).catch(() => {})
  }
}

main().catch((error) => {
  process.stderr.write(`llm-wiki MCP startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
