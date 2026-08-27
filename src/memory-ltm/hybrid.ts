import type { MemoryEntry } from './types.js'
import { cosineSimilarity } from './tokenize.js'
import { BM25 } from './bm25.js'

/**
 * Hybrid retrieval with RRF (Reciprocal Rank Fusion) fusion.
 *
 * Two independent retrieval channels produce ranked candidate lists:
 *  - BM25 lexical scores (local in-memory index over entry content)
 *  - Chroma vector cosine similarity (persistent vector store)
 *
 * The channels are fused with RRF: score = Σ 1/(k + rank), k = rrfK (default
 * 60). RRF only looks at ranks, so the two channels never need score
 * normalization against each other. The fused list is then handed to the
 * reranker for fine-grained re-scoring (top-N).
 */

export type RetrievalDetail = {
  id: string
  scope: MemoryEntry['scope']
  content: string
  score: number
}

export type RetrievalDetails = {
  /** Pure BM25 top results (one retrieval channel). */
  bm25Top: RetrievalDetail[]
  /** Pure vector cosine top results (second retrieval channel). */
  vectorTop: RetrievalDetail[]
  /** RRF-fused (pre-rerank) top results. */
  fusedTop: RetrievalDetail[]
}

/** RRF fusion over ranked lists of ids. k is the fusion rank constant. */
export function rrfFuse(
  rankedLists: Array<Array<{ id: string }>>,
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>()
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!.id
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
}

/** Compute detailed hybrid retrieval info for trace recording. */
export function computeRetrievalDetails(args: {
  entries: MemoryEntry[]
  query: string
  queryEmbedding: number[] | null
  bm25Weight: number
  vectorWeight: number
  topK: number
  rrfK?: number
}): RetrievalDetails {
  const { entries, query, queryEmbedding, topK, rrfK } = args

  const bm25 = new BM25(entries.map(entry => entry.content))
  const bm25Scores = bm25.scoreAll(query)

  const bm25Top: RetrievalDetail[] = entries
    .map((entry, index) => ({
      entry,
      index,
      score: bm25Scores[index],
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(item => ({
      id: item.entry.id,
      scope: item.entry.scope,
      content: item.entry.content,
      score: item.score,
    }))

  const vectorTop: RetrievalDetail[] = entries
    .map(entry => ({
      entry,
      score:
        queryEmbedding && entry.embedding && entry.embedding.length > 0
          ? Math.max(0, cosineSimilarity(queryEmbedding, entry.embedding))
          : 0,
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(item => ({
      id: item.entry.id,
      scope: item.entry.scope,
      content: item.entry.content,
      score: item.score,
    }))

  const fusedTop: RetrievalDetail[] = rrfFuse(
    [bm25Top, vectorTop],
    rrfK ?? 60,
  )
    .map(fused => {
      const entry = entries.find(item => item.id === fused.id)
      return entry
        ? { id: entry.id, scope: entry.scope, content: entry.content, score: fused.score }
        : null
    })
    .filter((item): item is RetrievalDetail => item !== null)
    .slice(0, topK)

  return { bm25Top, vectorTop, fusedTop }
}
