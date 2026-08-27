import { tokenize } from './tokenize.js'

/**
 * Minimal BM25 (Okapi) implementation. IDF and document stats are computed
 * lazily over the corpus; a document's score for a query is the sum of
 * per-term BM25 scores. No external dependencies.
 */

const K1 = 1.5
const B = 0.75

type CorpusStats = {
  docCount: number
  avgDocLength: number
  docLengths: number[]
  /** term -> number of documents containing the term */
  docFreq: Map<string, number>
}

function buildCorpusStats(documents: string[]): CorpusStats {
  const docLengths = documents.map(doc => tokenize(doc).length)
  const totalLength = docLengths.reduce((sum, len) => sum + len, 0)
  const docFreq = new Map<string, number>()
  for (const document of documents) {
    const seen = new Set(tokenize(document))
    for (const term of seen) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    }
  }
  return {
    docCount: documents.length,
    avgDocLength: documents.length === 0 ? 0 : totalLength / documents.length,
    docLengths,
    docFreq,
  }
}

function idf(stats: CorpusStats, term: string): number {
  const n = stats.docFreq.get(term) ?? 0
  // Smoothing keeps the score finite for terms seen in every document.
  return Math.log(1 + (stats.docCount - n + 0.5) / (n + 0.5))
}

/** Score one document against a query within the corpus. */
function scoreDocument(
  stats: CorpusStats,
  documentIndex: number,
  document: string,
  queryTerms: string[],
): number {
  const docLength = stats.docLengths[documentIndex]
  const termCounts = new Map<string, number>()
  for (const term of tokenize(document)) {
    termCounts.set(term, (termCounts.get(term) ?? 0) + 1)
  }

  let score = 0
  for (const term of queryTerms) {
    const tf = termCounts.get(term) ?? 0
    if (tf === 0) continue
    const idfValue = idf(stats, term)
    const denominator = tf + K1 * (1 - B + B * (docLength / Math.max(1, stats.avgDocLength)))
    score += idfValue * ((tf * (K1 + 1)) / denominator)
  }
  return score
}

export class BM25 {
  private readonly stats: CorpusStats

  constructor(private readonly documents: string[]) {
    this.stats = buildCorpusStats(documents)
  }

  get documentCount(): number {
    return this.stats.docCount
  }

  /** Query term frequencies used for scoring. */
  queryTerms(query: string): string[] {
    return tokenize(query)
  }

  /** BM25 score of a single document (by index) for a query. */
  score(query: string, documentIndex: number): number {
    if (documentIndex < 0 || documentIndex >= this.documents.length) {
      return 0
    }
    return scoreDocument(
      this.stats,
      documentIndex,
      this.documents[documentIndex],
      this.queryTerms(query),
    )
  }

  /** Scores of every document for a query, aligned with the corpus order. */
  scoreAll(query: string): number[] {
    const terms = this.queryTerms(query)
    if (terms.length === 0) {
      return this.documents.map(() => 0)
    }
    return this.documents.map((document, index) =>
      scoreDocument(this.stats, index, document, terms),
    )
  }
}
