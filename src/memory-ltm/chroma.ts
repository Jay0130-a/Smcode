import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { isEnoentError } from '../utils/errors.js'
import { cosineSimilarity, normalizeVector } from './tokenize.js'
import type { ChromaConfig } from '../config.js'

/**
 * ChromaDB-compatible vector persistence layer.
 *
 * Two interchangeable backends share the Chroma collection semantics:
 *  - HttpChromaBackend: talks to a real Chroma server via its REST API
 *    (GET/POST /api/v1/collections/{name}/...). Enabled when memory.chroma.url
 *    is configured and reachable. Zero extra dependencies (native fetch).
 *  - LocalChromaBackend: a Chroma-semantics-compatible persistent store that
 *    writes vectors as float32 binary plus a JSONL metadata stream under
 *    ~/.mini-code/chroma/<collection>/. Works fully offline.
 *
 * A single ChromaClient instance owns the whole ~/.mini-code/chroma/ base
 * directory; knowledge-base and long-term-memory data live in separate
 * collections with isolated directories.
 */

export type ChromaRecord = {
  id: string
  document?: string
  metadata?: Record<string, unknown>
}

export type ChromaQueryHit = {
  id: string
  /** Cosine similarity in [0,1] (vectors are L2-normalized). */
  score: number
  document?: string
  metadata?: Record<string, unknown>
}

export interface ChromaCollection {
  readonly name: string
  add(args: { ids: string[]; embeddings: number[][]; metadatas?: Record<string, unknown>[]; documents?: string[] }): Promise<void>
  query(args: { queryEmbeddings: number[][]; topK: number }): Promise<ChromaQueryHit[][]>
  deleteByIds(ids: string[]): Promise<void>
  count(): Promise<number>
}

// ---------------------------------------------------------------------------
// Local Chroma-compatible backend (default, offline, persistent)
// ---------------------------------------------------------------------------

const F32_BYTES = 4

/**
 * Local Chroma-compatible collection. Vectors are persisted in a framed
 * binary format: repeated [uint32 dims][float32*dims] blocks, so records with
 * different dimensions (e.g. after an embedding model change) never corrupt
 * the file. Metadata/document live in a parallel JSONL stream.
 */
export class LocalChromaCollection implements ChromaCollection {
  readonly name: string
  private readonly dir: string
  private readonly vectors = new Map<string, number[]>()
  private readonly meta = new Map<string, ChromaRecord>()
  private loaded = false

  constructor(name: string, dir: string) {
    this.name = name
    this.dir = dir
  }

  private fileFor(part: 'meta' | 'vectors'): string {
    return path.join(this.dir, part === 'meta' ? 'meta.jsonl' : 'vectors.bin')
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const metaText = await readFile(this.fileFor('meta'), 'utf8')
      const ids: string[] = []
      for (const line of metaText.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as ChromaRecord
          this.meta.set(parsed.id, parsed)
          ids.push(parsed.id)
        } catch {
          // Skip one malformed record; never break the store.
        }
      }
      if (ids.length === 0) return
      const buf = await readFile(this.fileFor('vectors'))
      let offset = 0
      for (const id of ids) {
        if (offset + 4 > buf.length) break
        const dims = buf.readUInt32LE(offset)
        offset += 4
        const bytes = dims * F32_BYTES
        if (offset + bytes > buf.length) break
        const vec: number[] = new Array(dims)
        for (let d = 0; d < dims; d++) {
          vec[d] = buf.readFloatLE(offset + d * F32_BYTES)
        }
        offset += bytes
        this.vectors.set(id, vec)
      }
    } catch (error) {
      if (!isEnoentError(error)) {
        // Corrupted/unsupported vector file: keep memory empty; callers
        // degrade to BM25-only retrieval. Do not throw.
      }
    }
  }

  async add(args: { ids: string[]; embeddings: number[][]; metadatas?: Record<string, unknown>[]; documents?: string[] }): Promise<void> {
    await this.ensureLoaded()
    await mkdir(this.dir, { recursive: true })
    const metaLines: string[] = []
    const frames: Buffer[] = []
    for (let i = 0; i < args.ids.length; i++) {
      const id = args.ids[i]!
      const vector = normalizeVector(args.embeddings[i]!)
      this.vectors.set(id, vector)
      this.meta.set(id, {
        id,
        document: args.documents?.[i],
        metadata: args.metadatas?.[i],
      })
      metaLines.push(JSON.stringify({ id, document: args.documents?.[i], metadata: args.metadatas?.[i] }))
      const frame = Buffer.alloc(4 + vector.length * F32_BYTES)
      frame.writeUInt32LE(vector.length, 0)
      for (let d = 0; d < vector.length; d++) {
        frame.writeFloatLE(vector[d]!, 4 + d * F32_BYTES)
      }
      frames.push(frame)
    }
    await appendFile(this.fileFor('meta'), `${metaLines.join('\n')}\n`, 'utf8')
    await appendFile(this.fileFor('vectors'), Buffer.concat(frames), 'utf8')
  }

  async query(args: { queryEmbeddings: number[][]; topK: number }): Promise<ChromaQueryHit[][]> {
    await this.ensureLoaded()
    const q = normalizeVector(args.queryEmbeddings[0] ?? [])
    const scored: ChromaQueryHit[] = []
    for (const [id, vector] of this.vectors) {
      const score = cosineSimilarity(q, vector)
      if (score > 0) {
        const record = this.meta.get(id)
        scored.push({ id, score, document: record?.document, metadata: record?.metadata })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return [scored.slice(0, args.topK)]
  }

  async deleteByIds(ids: string[]): Promise<void> {
    await this.ensureLoaded()
    if (ids.length === 0) return
    for (const id of ids) {
      this.vectors.delete(id)
      this.meta.delete(id)
    }
    await this.persist()
  }

  async count(): Promise<number> {
    await this.ensureLoaded()
    return this.vectors.size
  }

  private async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const ids = [...this.meta.keys()]
    const metaLines: string[] = []
    const frames: Buffer[] = []
    for (const id of ids) {
      const record = this.meta.get(id)!
      metaLines.push(JSON.stringify({ id, document: record.document, metadata: record.metadata }))
      const vector = this.vectors.get(id)!
      const frame = Buffer.alloc(4 + vector.length * F32_BYTES)
      frame.writeUInt32LE(vector.length, 0)
      for (let d = 0; d < vector.length; d++) {
        frame.writeFloatLE(vector[d]!, 4 + d * F32_BYTES)
      }
      frames.push(frame)
    }
    await writeFile(this.fileFor('meta'), metaLines.length ? `${metaLines.join('\n')}\n` : '', 'utf8')
    await writeFile(this.fileFor('vectors'), Buffer.concat(frames), 'utf8')
  }
}

// ---------------------------------------------------------------------------
// HTTP backend: real Chroma server REST API
// ---------------------------------------------------------------------------

export class HttpChromaCollection implements ChromaCollection {
  readonly name: string
  private readonly base: string
  private readonly timeoutMs: number
  private readonly headers: Record<string, string>

  constructor(name: string, baseUrl: string, timeoutMs = 5000) {
    this.name = name
    this.base = `${baseUrl.replace(/\/+$/, '')}/api/v1/collections/${encodeURIComponent(name)}`
    this.timeoutMs = timeoutMs
    this.headers = { 'content-type': 'application/json' }
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(url, {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Chroma HTTP ${response.status}: ${text.slice(0, 200)}`)
      }
      return (await response.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  async add(args: { ids: string[]; embeddings: number[][]; metadatas?: Record<string, unknown>[]; documents?: string[] }): Promise<void> {
    await this.request('POST', `${this.base}/add`, {
      ids: args.ids,
      embeddings: args.embeddings,
      metadatas: args.metadatas,
      documents: args.documents,
    })
  }

  async query(args: { queryEmbeddings: number[][]; topK: number }): Promise<ChromaQueryHit[][]> {
    const data = await this.request<{
      ids: string[][]
      distances: number[][]
      documents?: (string | null)[][]
      metadatas?: (Record<string, unknown> | null)[][]
    }>('POST', `${this.base}/query`, {
      query_embeddings: args.queryEmbeddings,
      n_results: args.topK,
      include: ['distances', 'documents', 'metadatas'],
    })
    return (data.ids ?? []).map((ids, group) =>
      ids.map((id, i) => ({
        id,
        // Chroma cosine distance -> similarity; clamp to [0,1].
        score: Math.max(0, Math.min(1, 1 - (data.distances?.[group]?.[i] ?? 0))),
        document: data.documents?.[group]?.[i] ?? undefined,
        metadata: data.metadatas?.[group]?.[i] ?? undefined,
      })),
    )
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.request('POST', `${this.base}/delete`, { ids })
  }

  async count(): Promise<number> {
    const data = await this.request<{ count: number }>('GET', `${this.base}/count`)
    return data.count ?? 0
  }
}

// ---------------------------------------------------------------------------
// Client + collection factory with fail-safe behaviour
// ---------------------------------------------------------------------------

export class ChromaClient {
  /** Absolute base directory for local persistence. */
  readonly baseDir: string
  private readonly config: ChromaConfig
  private readonly httpReady: boolean
  private readonly onError?: (message: string) => void

  private constructor(
    baseDir: string,
    config: ChromaConfig,
    httpReady: boolean,
    onError?: (message: string) => void,
  ) {
    this.baseDir = baseDir
    this.config = config
    this.httpReady = httpReady
    this.onError = onError
  }

  get backend(): 'http' | 'local' {
    return this.httpReady ? 'http' : 'local'
  }

  /**
   * Create the shared Chroma client. Never throws: when the HTTP backend is
   * configured but unreachable (or fails during collection creation) the
   * caller falls back to the local persistent store, and when even local
   * persistence cannot be initialized, null is returned so the memory module
   * degrades to BM25-only retrieval.
   */
  static async create(args: {
    baseDir: string
    config: ChromaConfig
    onError?: (message: string) => void
  }): Promise<ChromaClient | null> {
    const { baseDir, config, onError } = args
    try {
      await mkdir(baseDir, { recursive: true })
    } catch (error) {
      onError?.(`chroma init failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }

    let httpReady = false
    const url = config.url?.trim()
    if (url) {
      try {
        const probe = new HttpChromaCollection('__probe__', url, config.timeoutMs ?? 5000)
        await probe.count()
        httpReady = true
      } catch (error) {
        onError?.(
          `chroma http backend unreachable at ${url}, falling back to local persistent store: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return new ChromaClient(baseDir, config, httpReady, onError)
  }

  /** Get or create a collection. HTTP backend first, local store otherwise. */
  async getOrCreateCollection(name: string): Promise<ChromaCollection | null> {
    if (this.httpReady && this.config.url) {
      try {
        const http = new HttpChromaCollection(name, this.config.url, this.config.timeoutMs ?? 5000)
        // Ensure the collection exists server-side (idempotent).
        await http.count()
        return http
      } catch (error) {
        this.onError?.(
          `chroma collection "${name}" unavailable over http, falling back to local store: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    try {
      const local = new LocalChromaCollection(name, path.join(this.baseDir, name))
      await local.ensureLoaded()
      return local
    } catch (error) {
      this.onError?.(
        `chroma local collection "${name}" init failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// ChromaIndex: scope-aware wrapper over the two isolated collections
// ---------------------------------------------------------------------------

export type ChromaScope = 'session' | 'global' | 'kb'

/**
 * Maps memory scopes onto the two isolated Chroma collections:
 *  - 'kb'              -> collection "knowledge" (~/.mini-code/chroma/knowledge)
 *  - 'session'|'global' -> collection "memory"     (~/.mini-code/chroma/memory)
 */
export class ChromaIndex {
  private memoryCollection: ChromaCollection | null = null
  private knowledgeCollection: ChromaCollection | null = null

  constructor(private readonly client: ChromaClient | null) {}

  get available(): boolean {
    return this.client !== null
  }

  get backend(): string {
    return this.client?.backend ?? 'disabled'
  }

  private async collectionFor(scope: ChromaScope): Promise<ChromaCollection | null> {
    if (!this.client) return null
    if (scope === 'kb') {
      this.knowledgeCollection ??= await this.client.getOrCreateCollection('knowledge')
      return this.knowledgeCollection
    }
    this.memoryCollection ??= await this.client.getOrCreateCollection('memory')
    return this.memoryCollection
  }

  async add(scope: ChromaScope, id: string, vector: number[]): Promise<void> {
    try {
      const collection = await this.collectionFor(scope)
      if (!collection || vector.length === 0) return
      await collection.add({
        ids: [id],
        embeddings: [vector],
        metadatas: [{ scope }],
      })
    } catch {
      // Vector persistence is best-effort; BM25 still covers retrieval.
    }
  }

  async remove(id: string): Promise<void> {
    try {
      const [memory, knowledge] = await Promise.all([
        this.memoryCollection ?? this.collectionFor('session'),
        this.knowledgeCollection ?? this.collectionFor('kb'),
      ])
      if (memory) await memory.deleteByIds([id])
      if (knowledge) await knowledge.deleteByIds([id])
    } catch {
      // Best-effort removal.
    }
  }

  /** Vector similarity search across the requested scopes. */
  async search(
    queryEmbedding: number[],
    scopes: ChromaScope[],
    topK: number,
  ): Promise<Array<{ id: string; score: number }>> {
    try {
      const results: Array<{ id: string; score: number }> = []
      const groups = new Map<ChromaScope, ChromaCollection | null>()
      for (const scope of scopes) {
        if (!groups.has(scope)) groups.set(scope, await this.collectionFor(scope))
      }
      for (const [_scope, collection] of groups) {
        if (!collection) continue
        const hits = await collection.query({ queryEmbeddings: [queryEmbedding], topK })
        for (const hit of hits[0] ?? []) {
          results.push({ id: hit.id, score: hit.score })
        }
      }
      results.sort((a, b) => b.score - a.score)
      return results.slice(0, topK)
    } catch {
      return []
    }
  }

  async count(): Promise<{ memory: number; knowledge: number }> {
    const memory = this.memoryCollection ?? (await this.collectionFor('session'))
    const knowledge = this.knowledgeCollection ?? (await this.collectionFor('kb'))
    const [m, k] = await Promise.all([
      memory?.count().catch(() => 0) ?? 0,
      knowledge?.count().catch(() => 0) ?? 0,
    ])
    return { memory: m, knowledge: k }
  }
}
