/**
 * Lightweight text tokenization shared by BM25 and the local embedding
 * provider. Handles English words, numbers and CJK text (character bigrams).
 * No external dependencies — keeps the project's minimal dependency style.
 */

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

function isCjk(char: string): boolean {
  return CJK_RE.test(char)
}

function tokenizeCjk(text: string): string[] {
  const chars = text.split('')
  const tokens: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (!isCjk(chars[i])) continue
    tokens.push(chars[i])
    if (i + 1 < chars.length && isCjk(chars[i + 1])) {
      tokens.push(chars[i] + chars[i + 1])
    }
  }
  return tokens
}

/** Tokenize mixed text into lowercased terms. */
export function tokenize(text: string): string[] {
  const normalized = String(text).toLowerCase()
  const words = normalized.split(/[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/).filter(Boolean)
  const tokens: string[] = []
  for (const word of words) {
    if (isCjk(word[0] ?? '')) {
      tokens.push(...tokenizeCjk(word))
    } else {
      tokens.push(word)
    }
  }
  return tokens
}

/** Euclidean (L2) normalization in place. */
export function normalizeVector(vector: number[]): number[] {
  let norm = 0
  for (const value of vector) {
    norm += value * value
  }
  norm = Math.sqrt(norm)
  if (norm === 0) {
    return vector.map(() => 0)
  }
  for (let i = 0; i < vector.length; i++) {
    vector[i] = vector[i] / norm
  }
  return vector
}

/** Cosine similarity between two equal-length vectors (0 when either is empty). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/** Truncate text to a maximum length while preserving whole words where possible. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  if (lastSpace > maxChars * 0.6) {
    return cut.slice(0, lastSpace) + '\n…[truncated]'
  }
  return cut + '\n…[truncated]'
}
