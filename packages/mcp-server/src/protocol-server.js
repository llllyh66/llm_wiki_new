import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createRequire } from "node:module"

const packageVersion = createRequire(import.meta.url)("../package.json").version

const DEFAULT_MCP_MAX_RETRIES = 3
const DEFAULT_MCP_RETRY_BASE_MS = 250
const MAX_MCP_RETRY_DELAY_MS = 5_000
const TRANSIENT_TOOL_ERROR_CODES = new Set(["MCP_BUSY", "TASK_BUSY", "WORKSPACE_LOCKED"])

export function readInteger(name, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)))
}

export function safeByteLength(value) {
  try {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null))
  } catch {
    return null
  }
}

export function createProtocolServer(router, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {}
  const isDegraded = typeof options.isDegraded === "function" ? options.isDegraded : () => false
  const maxRetries = options.maxRetries ?? readInteger("LLM_WIKI_MCP_MAX_RETRIES", DEFAULT_MCP_MAX_RETRIES, { maximum: 5 })
  const retryBaseMs = options.retryBaseMs ?? readInteger("LLM_WIKI_MCP_RETRY_BASE_MS", DEFAULT_MCP_RETRY_BASE_MS, { minimum: 50, maximum: 5_000 })
  const server = new Server({ name: "llm-wiki", version: packageVersion }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: router.listTools() }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const startedAt = Date.now()
    const name = request?.params?.name ?? "<invalid-tool>"
    const args = request?.params?.arguments ?? {}
    const requestId = request?.id ?? null
    const inputBytes = safeByteLength(args)
    log("tool-call-start", { requestId, name, inputBytes, ...router.runtimeStats(), degraded: isDegraded() })

    try {
      let result
      let retryCount = 0
      for (;;) {
        result = await router.callMcp(name, args, { signal: extra?.signal, requestId })
        const retry = retryDirective(result, retryCount, maxRetries, retryBaseMs, extra?.signal)
        if (!retry) break
        retryCount += 1
        log("tool-retry", {
          requestId,
          name,
          retryCount,
          maxRetries,
          delayMs: retry.delayMs,
          errorCode: retry.errorCode,
        })
        await abortableDelay(retry.delayMs, extra?.signal)
        if (extra?.signal?.aborted) break
      }

      const structured = result.structuredContent
      const status = result._meta?.llmWikiStatus === "rejected" || structured?.accepted === false ? "rejected" : "ok"
      log("tool-call", {
        requestId,
        name,
        status,
        durationMs: Date.now() - startedAt,
        outputBytes: safeByteLength(result?.content?.[0]?.text),
        ...router.runtimeStats(),
      })
      return result
    } catch (error) {
      // This is a last-resort SDK boundary guard. Normally callMcp already
      // catches and serializes every Core error; returning a protocol-safe
      // result here prevents one unexpected handler failure from closing MCP.
      log("tool-handler-error", {
        requestId,
        name,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      })
      const data = {
        ok: false,
        accepted: false,
        rejected: true,
        error: { code: "MCP_HANDLER_ERROR", message: "Tool handler failed; retry the operation.", retryable: true },
        next_action: { tool: "llm_wiki_list_tasks", arguments: {} },
        mcp_connection_usable: true,
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
      }
    }
  })

  return server
}

function retryDirective(result, retryCount, maxRetries, retryBaseMs, signal) {
  if (signal?.aborted || retryCount >= maxRetries) return null
  const error = result?.structuredContent?.error
  if (!error?.retryable || !TRANSIENT_TOOL_ERROR_CODES.has(error.code)) return null
  const requestedDelay = Number(error.details?.retry_after_ms)
  const exponentialDelay = retryBaseMs * (2 ** retryCount)
  const delayMs = Math.min(
    MAX_MCP_RETRY_DELAY_MS,
    Math.max(retryBaseMs, Number.isFinite(requestedDelay) ? requestedDelay : exponentialDelay),
  )
  return { delayMs, errorCode: error.code }
}

function abortableDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs)
    const onAbort = () => done()
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", onAbort)
      resolve()
    }
    signal?.addEventListener?.("abort", onAbort, { once: true })
  })
}
