const MAX_EVIDENCE_QUOTE_CHARS = 600
// Keep enough row-level granularity for extraction while leaving room in the
// complete get_batch response for explicit primary/context metadata. Dense
// table lines are merged into bounded coherent passages below this ceiling.
const MAX_EVIDENCE_REFS_PER_CHUNK = 16
const MAX_EVIDENCE_REFS_PER_BATCH = 400

export function batchEvidenceCatalog(chunks) {
  const catalog = []
  const seen = new Set()
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const templates = Array.isArray(chunk?.source_ref_templates) ? chunk.source_ref_templates : []
    if (templates.length === 0) continue
    for (const segment of evidenceQuoteSegments(chunk.text)) {
      const quote = chunk.text.slice(segment.start, segment.end)
      const templateIndex = matchingTemplateIndex(chunk, templates, quote)
      const sourceRef = { ...templates[templateIndex], quote, role: "primary" }
      const context = evidenceContext(chunk, segment)
      const contextQuotes = context.quotes
      const contextSourceRefs = contextQuotes.map((contextQuote) => {
        const contextTemplateIndex = matchingTemplateIndex(chunk, templates, contextQuote)
        return {
          ...templates[contextTemplateIndex],
          quote: contextQuote,
          role: "context",
        }
      })
      const signature = JSON.stringify({ sourceRef, contextSourceRefs })
      if (seen.has(signature)) continue
      seen.add(signature)
      catalog.push({
        chunkIndex,
        templateIndex,
        sourceRef,
        contextSourceRefs,
        primaryQuote: quote,
        contextQuotes,
        context: context.metadata,
      })
      if (catalog.length >= MAX_EVIDENCE_REFS_PER_BATCH) return catalog
    }
  }
  return catalog
}

export function compactEvidenceCatalog(catalog) {
  return catalog.map((entry, evidenceIndex) => ({
    evidence_index: evidenceIndex,
    chunk_index: entry.chunkIndex,
    template_index: entry.templateIndex,
    // `quote` remains as a compatibility alias. New workers should use the
    // explicit primary/context fields so table semantics are visible before
    // an analysis is submitted.
    quote: entry.primaryQuote ?? entry.sourceRef.quote,
    primary_quote: entry.primaryQuote ?? entry.sourceRef.quote,
    context_quotes: Array.isArray(entry.contextQuotes) ? entry.contextQuotes : [],
    context: entry.context ?? {},
    evidence_role: "primary",
  }))
}

function matchingTemplateIndex(chunk, templates, quote) {
  const tables = Array.isArray(chunk?.structuredData) ? chunk.structuredData : []
  const table = tables.find((item) => typeof item?.markdown === "string" && item.markdown.includes(quote))
  if (!table) return 0
  const index = templates.findIndex((template) => (
    (table.sheetName === undefined || template.locator?.sheetName === table.sheetName)
    && (table.cellRange === undefined || template.locator?.cellRange === table.cellRange)
  ))
  return index >= 0 ? index : 0
}

function evidenceQuoteSegments(value) {
  if (typeof value !== "string" || !value.trim()) return []
  const lineSegments = []
  const linePattern = /[^\r\n]+/g
  for (const match of value.matchAll(linePattern)) {
    const bounds = trimBounds(value, match.index, match.index + match[0].length)
    if (!bounds || !hasEvidenceText(value.slice(bounds.start, bounds.end))) continue
    lineSegments.push(...splitBounded(value, bounds.start, bounds.end))
  }
  if (lineSegments.length === 0) {
    const bounds = trimBounds(value, 0, value.length)
    if (!bounds) return []
    return [{ start: bounds.start, end: Math.min(bounds.end, bounds.start + MAX_EVIDENCE_QUOTE_CHARS) }]
  }
  const bounded = lineSegments.length <= MAX_EVIDENCE_REFS_PER_CHUNK
    ? lineSegments
    : mergeDenseSegments(value, lineSegments)
  return bounded.slice(0, MAX_EVIDENCE_REFS_PER_CHUNK)
}

function evidenceContext(chunk, segment) {
  const text = typeof chunk?.text === "string" ? chunk.text : ""
  const quotes = []
  const metadata = {
    ...(Array.isArray(chunk?.headingPath) && chunk.headingPath.length > 0
      ? { heading_path: chunk.headingPath.slice(0, 12) }
      : {}),
  }
  const table = tableHeaderContext(text, segment)
  if (table) {
    quotes.push(table.quote)
    metadata.table_headers = table.headers
    metadata.column_names = table.headers
    metadata.context_kind = "table-header"
  }
  // A heading is useful semantic context only when it is also present in the
  // chunk text. We never manufacture a SourceRef quote from metadata alone.
  const headingQuotes = (Array.isArray(chunk?.headingPath) ? chunk.headingPath : [])
    .map((heading) => lineContaining(text, heading))
    .filter(Boolean)
  for (const heading of headingQuotes) {
    if (!quotes.includes(heading)) quotes.push(heading)
  }
  if (headingQuotes.length > 0 && metadata.context_kind === undefined) metadata.context_kind = "heading"
  return { quotes, metadata }
}

function tableHeaderContext(text, segment) {
  const lines = []
  const pattern = /[^\r\n]+/g
  for (const match of text.matchAll(pattern)) {
    lines.push({ start: match.index, end: match.index + match[0].length, text: match[0].trim() })
  }
  const lineIndex = lines.findIndex((line) => segment.start < line.end && segment.end > line.start)
  if (lineIndex < 0 || !isMarkdownTableLine(lines[lineIndex].text)) return null
  let first = lineIndex
  while (first > 0 && isMarkdownTableLine(lines[first - 1].text)) first -= 1
  let last = lineIndex
  while (last + 1 < lines.length && isMarkdownTableLine(lines[last + 1].text)) last += 1
  if (last - first < 2 || !isMarkdownDelimiterLine(lines[first + 1].text)) return null
  const header = lines[first]
  if (segment.start < header.end && segment.end > header.start) return null
  const headerQuotes = splitBounded(text, header.start, header.end)
    .map(({ start, end }) => text.slice(start, end))
  return {
    quote: headerQuotes[0] ?? header.text,
    headers: parseTableCells(header.text),
  }
}

function lineContaining(text, value) {
  if (typeof value !== "string" || !value.trim()) return null
  const pattern = /[^\r\n]+/g
  for (const match of text.matchAll(pattern)) {
    const line = match[0].trim()
    if (line && line.includes(value.trim())) return line
  }
  return null
}

function parseTableCells(value) {
  if (!isMarkdownTableLine(value)) return []
  return value.trim().slice(1, -1).split("|").map((cell) => cell.trim())
}

function isMarkdownTableLine(value) {
  return /^\s*\|.*\|\s*$/u.test(value)
}

function isMarkdownDelimiterLine(value) {
  const cells = value.trim().slice(1, -1).split("|").map((cell) => cell.trim())
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
}

function mergeDenseSegments(text, segments) {
  const groupSize = Math.ceil(segments.length / MAX_EVIDENCE_REFS_PER_CHUNK)
  const merged = []
  for (let index = 0; index < segments.length; index += groupSize) {
    const group = segments.slice(index, index + groupSize)
    merged.push(...splitBounded(text, group[0].start, group.at(-1).end))
  }
  if (merged.length <= MAX_EVIDENCE_REFS_PER_CHUNK) return merged
  const secondGroupSize = Math.ceil(merged.length / MAX_EVIDENCE_REFS_PER_CHUNK)
  const compacted = []
  for (let index = 0; index < merged.length; index += secondGroupSize) {
    const group = merged.slice(index, index + secondGroupSize)
    const bounds = trimBounds(text, group[0].start, group.at(-1).end)
    if (bounds) compacted.push(bounds)
  }
  return compacted
}

function splitBounded(text, start, end) {
  const segments = []
  let cursor = start
  while (end - cursor > MAX_EVIDENCE_QUOTE_CHARS) {
    const maximum = cursor + MAX_EVIDENCE_QUOTE_CHARS
    const minimum = cursor + Math.floor(MAX_EVIDENCE_QUOTE_CHARS * 0.6)
    const window = text.slice(minimum, maximum + 1)
    let relativeCut = -1
    for (const boundary of ["\n", "。", "！", "？", ";", "；", ". ", " "]) {
      const found = window.lastIndexOf(boundary)
      if (found >= 0) relativeCut = Math.max(relativeCut, found + boundary.length)
    }
    const cut = relativeCut >= 0 ? minimum + relativeCut : maximum
    const bounds = trimBounds(text, cursor, cut)
    if (bounds && hasEvidenceText(text.slice(bounds.start, bounds.end))) segments.push(bounds)
    cursor = cut
    while (cursor < end && /\s/u.test(text[cursor])) cursor += 1
  }
  const bounds = trimBounds(text, cursor, end)
  if (bounds && hasEvidenceText(text.slice(bounds.start, bounds.end))) segments.push(bounds)
  return segments
}

function trimBounds(text, start, end) {
  while (start < end && /\s/u.test(text[start])) start += 1
  while (end > start && /\s/u.test(text[end - 1])) end -= 1
  return start < end ? { start, end } : null
}

function hasEvidenceText(value) {
  if (/^```/.test(value) || /^\|?[\s:|-]+\|?$/.test(value)) return false
  return /[\p{L}\p{N}]/u.test(value)
}
