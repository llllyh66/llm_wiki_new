import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true })
await mkdir(new URL("../dist", import.meta.url), { recursive: true })
await cp(new URL("../src", import.meta.url), new URL("../dist", import.meta.url), { recursive: true })

let gitCommit = "unknown"
try {
  const result = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: new URL("../../..", import.meta.url) })
  gitCommit = result.stdout.trim() || gitCommit
} catch {
  // Building from an unpacked package is supported; the runtime still reports
  // the build timestamp and marks the commit as unknown.
}
await writeFile(
  new URL("../dist/build-info.json", import.meta.url),
  `${JSON.stringify({ schemaVersion: 1, packageVersion: "1.0.1", gitCommit, builtAt: new Date().toISOString() }, null, 2)}\n`,
  "utf8",
)
