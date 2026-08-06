import { readFile } from "node:fs/promises"
import path from "node:path"
import { listFilesRecursive, relativePosix } from "./utils.js"
import { extractRelatedReferences, parseWikiPage } from "./wiki-page.js"

export async function lintWiki(workspace, selectedPaths) {
  const allFiles = await listFilesRecursive(workspace.paths.wiki, (candidate) => candidate.endsWith(".md"))
  const selected = Array.isArray(selectedPaths) && selectedPaths.length > 0
    ? new Set(selectedPaths.map((value) => value.replace(/\\/g, "/")))
    : null
  const pages = []
  for (const file of allFiles) {
    const relative = `wiki/${relativePosix(workspace.paths.wiki, file)}`
    const content = await readFile(file, "utf8")
    const parsed = parseWikiPage(content)
    const title = parsed.title || path.basename(file, ".md")
    const links = [...new Set([...parsed.related, ...extractRelatedReferences(parsed.body)].map(normalizeLink))]
    pages.push({ relative, slug: relative.replace(/^wiki\//, "").replace(/\.md$/i, ""), basename: path.basename(file, ".md"), title, links, content, parsed, selected: !selected || selected.has(relative) })
  }
  const exact = new Map()
  const aliases = new Map()
  pages.forEach((page, index) => {
    exact.set(normalizeLink(page.slug), index)
    for (const alias of [page.basename, page.title]) {
      const key = normalizeLink(alias)
      const indexes = aliases.get(key) ?? new Set()
      indexes.add(index)
      aliases.set(key, indexes)
    }
  })
  const uniqueAlias = (value) => {
    const indexes = aliases.get(normalizeLink(value))
    return indexes?.size === 1 ? [...indexes][0] : undefined
  }
  const inbound = new Array(pages.length).fill(0)
  const findings = []
  pages.forEach((page, pageIndex) => {
    if (!page.selected) return
    if (!page.content.trim()) findings.push({ code: "EMPTY_PAGE", severity: "error", page: page.relative, detail: "Page is empty." })
    for (const link of page.links) {
      const target = exact.get(link) ?? uniqueAlias(path.posix.basename(link))
      if (target === undefined) findings.push({ code: "BROKEN_LINK", severity: "warning", page: page.relative, detail: `Broken wikilink: [[${link}]]` })
      else inbound[target] += 1
    }
    if (page.links.length === 0 && !isAggregate(page.relative)) findings.push({ code: "NO_OUTLINKS", severity: "info", page: page.relative, detail: "Page has no wikilinks." })
    if (!/^#\s+/m.test(page.content)) findings.push({ code: "MISSING_TITLE", severity: "warning", page: page.relative, detail: "Page has no level-one heading." })
    if (!isAggregate(page.relative)) {
      const missingFields = ["type", "title", "created", "updated", "tags", "related", "sources", "covers", "summary"]
        .filter((field) => page.parsed.fields[field] === undefined)
      if (missingFields.length > 0) findings.push({ code: "INCOMPLETE_FRONTMATTER", severity: "warning", page: page.relative, detail: `Missing standard frontmatter fields: ${missingFields.join(", ")}` })
    }
  })
  pages.forEach((page, index) => {
    if (!page.selected) return
    if (inbound[index] === 0 && !isAggregate(page.relative)) findings.push({ code: "ORPHAN_PAGE", severity: "info", page: page.relative, detail: "No other page links to this page." })
  })
  return {
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
    info: findings.filter((finding) => finding.severity === "info").length,
    findings,
  }
}

function normalizeLink(value) {
  return value.normalize("NFKC").replace(/\\/g, "/").replace(/^wiki\//i, "").replace(/\.md$/i, "").trim().toLowerCase()
}

function isAggregate(value) {
  return new Set(["wiki/index.md", "wiki/overview.md", "wiki/log.md"]).has(value)
}
