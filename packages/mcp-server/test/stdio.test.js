import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

test("built MCP server starts over STDIO without desktop or HTTP", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-stdio-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--workspace", workspace],
    stderr: "pipe",
  })
  const client = new Client({ name: "llm-wiki-contract-test", version: "1.0.0" })
  t.after(() => transport.close().catch(() => {}))
  await client.connect(transport)
  const listed = await client.listTools()
  assert.equal(listed.tools.some((tool) => tool.name === "llm_wiki_import_files"), true)
  assert.equal(listed.tools.some((tool) => tool.name === "llm_wiki_projects"), false)
  const lint = await client.callTool({ name: "llm_wiki_lint", arguments: {} })
  assert.equal(lint.isError, undefined)
  assert.equal(lint.structuredContent.errors, 0)
})
