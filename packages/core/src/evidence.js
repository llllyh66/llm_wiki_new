const MAX_EVIDENCE_QUOTE_CHARS = 600
const MAX_EVIDENCE_REFS_PER_CHUNK = 100
const MAX_EVIDENCE_REFS_PER_BATCH = 400

export function batchEvidenceCatalog(chunks) {
  const catalog = []
  const seen = new Set()
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const templates = Array.isArray(chunk?.source_ref_templates) ? chunk.source_ref_templates : []
    if (templates.length === 0) continue
    for (const quote of evidenceQuotes(chunk.text)) {
      const templateIndex = matchingTemplateIndex(chunk, templates, quote)
      const sourceRef = { ...templates[templateIndex], quote }
      const signature = JSON.stringify(sourceRef)
      if (seen.has(signature)) continue
      seen.add(signature)
      catalog.push({ chunkIndex, templateIndex, sourceRef })
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
    quote: entry.sourceRef.quote,
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

function evidenceQuotes(value) {
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
    return [value.slice(bounds.start, Math.min(bounds.end, bounds.start + MAX_EVIDENCE_QUOTE_CHARS))]
  }
  const bounded = lineSegments.length <= MAX_EVIDENCE_REFS_PER_CHUNK
    ? lineSegments
    : mergeDenseSegments(value, lineSegments)
  return bounded.slice(0, MAX_EVIDENCE_REFS_PER_CHUNK).map(({ start, end }) => value.slice(start, end))
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
