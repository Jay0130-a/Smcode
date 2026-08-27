import type { MemoryEmbeddingConfig } from '../config.js'
import { normalizeVector, tokenize } from './tokenize.js'

/**
 * Unified embedding layer. Every consumer (RAG knowledge-base chunking and
 * long-term memory writes) goes through `embedTexts`, so an embedding
 * failure degrades both modules consistently instead of crashing the agent
 * turn. Failures are reported through the optional onError callback (wired
 * to the trace recorder by the caller).
 */

export type EmbeddingProvider = {
  name: string
  embed(texts: string[]): Promise<number[][]>
}

export const DEFAULT_EMBEDDING_MODEL = 'qwen3.7-text-embedding'
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024

const LOCAL_DIMENSIONS = 384

function hashTerm(term: string): number {
  let hash = 5381
  for (let i = 0; i < term.length; i++) {
    hash = ((hash << 5) + hash + term.charCodeAt(i)) >>> 0
  }
  return hash
}

/**
 * Deterministic, offline embedding provider. Each token is hashed into a
 * fixed-dimension bag-of-words vector, then L2-normalized. Cosine similarity
 * is meaningful for lexical overlap; works without any network or API key.
 * Used only when the user explicitly sets embedding.provider='local'.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  name = 'local'
  private readonly dimensions: number

  constructor(dimensions = LOCAL_DIMENSIONS) {
    this.dimensions = dimensions
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0)
    for (const term of tokenize(text)) {
      const index = hashTerm(term) % this.dimensions
      vector[index] += 1
    }
    return normalizeVector(vector)
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.embedOne(text))
  }
}

/**
 * OpenAI-compatible /embeddings provider. Default model is
 * qwen3.7-text-embedding. The base URL accepts both a root
 * (https://host) and an already-versioned (https://host/v1) form.
 */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  name = 'api'

  constructor(
    private readonly options: {
      baseUrl: string
      apiKey?: string
      model: string
    },
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const base = this.options.baseUrl.replace(/\/+$/, '')
    const url = /\/v1$/.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (this.options.apiKey) {
      headers.Authorization = `Bearer ${this.options.apiKey}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.options.model,
        input: texts,
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(
        `Embedding request failed (${response.status}): ${body.slice(0, 200)}`,
      )
    }
    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>
    }
    const vectors = (data.data ?? [])
      .slice(0, texts.length)
      .map(item => item.embedding ?? [])
    if (vectors.length < texts.length) {
      throw new Error(
        `Embedding response missing vectors: got ${vectors.length}, expected ${texts.length}`,
      )
    }
    return vectors.map(vector => normalizeVector([...vector]))
  }
}

/**
 * Build an embedding provider from validated settings.
 *  - provider 'api' (default): needs baseUrl; model defaults to
 *    qwen3.7-text-embedding. Returns null when baseUrl is missing so callers
 *    degrade to BM25-only retrieval instead of failing at runtime.
 *  - provider 'local': offline hash bag-of-words fallback.
 */
export function createEmbeddingProvider(
  config: MemoryEmbeddingConfig | undefined,
): EmbeddingProvider | null {
  const provider = config?.provider ?? 'api'
  if (provider === 'api') {
    const baseUrl = config?.baseUrl?.trim()
    const model = config?.model?.trim() || DEFAULT_EMBEDDING_MODEL
    if (baseUrl) {
      return new ApiEmbeddingProvider({ baseUrl, apiKey: config?.apiKey?.trim(), model })
    }
    return null
  }
  return new LocalEmbeddingProvider(config?.dimensions ?? LOCAL_DIMENSIONS)
}

export function embeddingDimensions(provider: EmbeddingProvider | null): number {
  if (provider instanceof ApiEmbeddingProvider) {
    return DEFAULT_EMBEDDING_DIMENSIONS
  }
  if (provider instanceof LocalEmbeddingProvider) {
    return provider['dimensions']
  }
  return LOCAL_DIMENSIONS
}

/**
 * Unified public embedding entry point. RAG knowledge-base chunking and
 * long-term memory writes both call this. On failure it reports the error
 * (trace log) and returns null — the caller degrades gracefully (BM25-only)
 * and the agent turn is never interrupted.
 */
export async function embedTexts(
  provider: EmbeddingProvider | null,
  texts: string[],
  onError?: (message: string) => void,
): Promise<number[][] | null> {
  if (!provider) return null
  if (texts.length === 0) return []
  try {
    return await provider.embed(texts)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onError?.(`embedding failed (${provider.name}): ${message}`)
    return null
  }
}
