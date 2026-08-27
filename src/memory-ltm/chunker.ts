/**
 * Built-in document chunking. Markdown-aware: splits by headings first, then
 * paragraphs, then fixed-size windows with overlap for very long sections.
 * Used when importing a local file knowledge base.
 */

export type Chunk = {
  text: string
  index: number
}

export type ChunkOptions = {
  maxChars?: number
  overlap?: number
  minChars?: number
}

const HEADING_RE = /^(#{1,4})\s+(.+)$/

function splitSections(text: string): string[] {
  const lines = text.split('\n')
  const sections: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (HEADING_RE.test(line.trim()) && current.length > 0) {
      sections.push(current.join('\n').trim())
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) {
    sections.push(current.join('\n').trim())
  }
  return sections.filter(section => section.length > 0)
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

function splitWindow(text: string, maxChars: number, overlap: number): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length)
    if (end < text.length) {
      // Prefer breaking at a sentence/space boundary near the limit.
      const window = text.slice(start, end)
      const lastSpace = window.lastIndexOf(' ')
      const lastNewline = window.lastIndexOf('\n')
      const boundary = Math.max(lastSpace, lastNewline)
      if (boundary > maxChars * 0.5) {
        end = start + boundary
      }
    }
    chunks.push(text.slice(start, end).trim())
    if (end >= text.length) break
    start = end - overlap
  }
  return chunks.filter(chunk => chunk.length > 0)
}

/** Chunk a document into overlapping, heading-aware pieces. */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? 1200
  const overlap = options.overlap ?? 120
  const minChars = options.minChars ?? 40
  const chunks: Chunk[] = []
  let index = 0

  for (const section of splitSections(text)) {
    if (section.length <= maxChars) {
      if (section.length >= minChars) {
        chunks.push({ text: section, index: index++ })
      }
      continue
    }
    for (const paragraph of splitParagraphs(section)) {
      if (paragraph.length <= maxChars) {
        if (paragraph.length >= minChars) {
          chunks.push({ text: paragraph, index: index++ })
        }
        continue
      }
      for (const window of splitWindow(paragraph, maxChars, overlap)) {
        if (window.length >= minChars) {
          chunks.push({ text: window, index: index++ })
        }
      }
    }
  }

  return chunks
}
