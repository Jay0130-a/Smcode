import type { MemoryRerankerConfig } from '../config.js'
import { tokenize } from './tokenize.js'
import type { MemoryEntry } from './types.js'

/**
 * Reranker stage of the RAG pipeline. After BM25 and vector retrieval are
 * fused into a candidate list, the reranker re-scores the candidates with
 * finer-grained query-document features and returns the top-N.
 */

export type RerankCandidate = {
  entry: MemoryEntry
  /** Fused BM25+vector score from the fusion stage. */
  score: number
  bm25Score: number
  vectorScore: number
  /** Reranker-produced score; equals the fused score when reranking is off. */
  rerankScore?: number
}

export interface Reranker {
  readonly name: string
  rerank(args: { query: string; candidates: RerankCandidate[]; topN: number }): Promise<RerankCandidate[]>
}

/**
 * Local, deterministic reranker. Re-scores fused candidates using:
 *  - the fused BM25+vector score (primary signal)
 *  - query term coverage ratio (secondary signal)
 *  - a mild length penalty so short, dense snippets are preferred
 * No network access — works offline by default.
 */
export class LocalReranker implements Reranker {
  readonly name = 'local'

  async rerank(args: { query: string; candidates: RerankCandidate[]; topN: number }): Promise<RerankCandidate[]> {
    const { query, candidates, topN } = args
    const queryTerms = new Set(tokenize(query))
    if (queryTerms.size === 0) {
      return candidates
        .map(candidate => ({ ...candidate, rerankScore: candidate.score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topN)
    }

    const reranked = candidates.map(candidate => {
      const docTerms = tokenize(candidate.entry.content)
      const docSet = new Set(docTerms)
      let covered = 0
      for (const term of queryTerms) {
        if (docSet.has(term)) covered += 1
      }
      const coverage = covered / queryTerms.size
      const lengthPenalty = 1 / Math.max(1, Math.sqrt(docTerms.length) / 6)
      const rerankScore = Math.min(
        1,
        candidate.score * 0.6 + coverage * 0.35 + lengthPenalty * 0.05,
      )
      return { ...candidate, rerankScore }
    })

    reranked.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0))
    return reranked.slice(0, topN)
  }
}

/**
 * API reranker calling an OpenAI-style /v1/rerank endpoint (Cohere-compatible
 * request/response shape: { model, query, documents } → { results:[{index,
 * relevance_score}] }). Only used when configured; any failure degrades to
 * the local reranker so retrieval never breaks.
 */
export class ApiReranker implements Reranker {
  readonly name = 'api'

  constructor(
    private readonly options: { baseUrl: string; apiKey?: string; model: string },
  ) {}

  async rerank(args: { query: string; candidates: RerankCandidate[]; topN: number }): Promise<RerankCandidate[]> {
    const { query, candidates, topN } = args
    if (candidates.length === 0) return []
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/v1/rerank`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.options.apiKey) {
      headers.Authorization = `Bearer ${this.options.apiKey}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.options.model,
        query,
        documents: candidates.map(candidate => candidate.entry.content),
        top_n: topN,
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Rerank request failed (${response.status}): ${body.slice(0, 200)}`)
    }
    const data = (await response.json()) as {
      results?: Array<{ index?: number; relevance_score?: number }>
    }
    const results = data.results ?? []
    const byIndex = new Map<number, number>()
    for (const result of results) {
      if (result.index !== undefined && result.relevance_score !== undefined) {
        byIndex.set(result.index, result.relevance_score)
      }
    }
    const reranked = candidates
      .map((candidate, index) => ({
        ...candidate,
        rerankScore: byIndex.get(index) ?? candidate.score,
      }))
      .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0))
      .slice(0, topN)
    return reranked
  }
}

/** Build a reranker from settings; defaults to the offline local reranker. */
export function createReranker(config: MemoryRerankerConfig | undefined): Reranker {
  if (config?.provider === 'api') {
    const baseUrl = config.baseUrl?.trim()
    const model = config.model?.trim()
    if (baseUrl && model) {
      return new ApiReranker({ baseUrl, apiKey: config.apiKey?.trim() || undefined, model })
    }
  }
  return new LocalReranker()
}
