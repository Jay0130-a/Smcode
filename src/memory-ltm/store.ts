import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isEnoentError } from '../utils/errors.js'
import { projectSlug } from '../utils/project-slug.js'
import { MINI_CODE_DIR } from '../config.js'
import type { MemoryEntry, MemoryMetadata, MemoryScope, MemoryStage } from './types.js'
import { normalizeVector, tokenize } from './tokenize.js'
import { BM25 } from './bm25.js'
import type { ChromaIndex } from './chroma.js'
import { rrfFuse } from './hybrid.js'

export type MemoryStoreOptions = {
  /** Base directory of the memory store. Defaults to ~/.mini-code/memory. */
  dir?: string
  cwd?: string
  maxEntriesPerScope?: number
  /** Chroma-backed vector index used for vector retrieval; null degrades to BM25-only. */
  chromaIndex?: ChromaIndex | null
}

/**
 * File-backed long-term memory store. Global memories live in
 * <dir>/global.jsonl; session memories are isolated per project in
 * <dir>/projects/<project-slug>.jsonl.
 *
 * The store keeps an in-memory cache, appends new entries to the JSONL file,
 * and rewrites the file when entries are deleted. Retrieval (BM25 + cosine)
 * is computed in memory, which keeps the dependency footprint minimal.
 */
/** Fill defaults for legacy entries that predate lifecycle fields. */
function normalizeEntry(entry: MemoryEntry): MemoryEntry {
  return {
    ...entry,
    stage: entry.stage ?? 'active',
    lastAccessedAt: entry.lastAccessedAt ?? entry.createdAt,
    accessCount: entry.accessCount ?? 0,
  }
}

export class MemoryStore {
  private readonly dir: string
  private readonly cwd: string
  private readonly maxEntriesPerScope: number
  private readonly chromaIndex: ChromaIndex | null
  private readonly cache = new Map<MemoryScope, MemoryEntry[]>()
  private loaded = false

  constructor(options: MemoryStoreOptions = {}) {
    this.dir = options.dir ?? path.join(MINI_CODE_DIR, 'memory')
    this.cwd = options.cwd ?? process.cwd()
    this.maxEntriesPerScope = options.maxEntriesPerScope ?? 500
    this.chromaIndex = options.chromaIndex ?? null
  }

  private fileFor(scope: MemoryScope): string {
    if (scope === 'global') {
      return path.join(this.dir, 'global.jsonl')
    }
    if (scope === 'kb') {
      return path.join(this.dir, 'projects', projectSlug(this.cwd), 'kb.jsonl')
    }
    return path.join(this.dir, 'projects', projectSlug(this.cwd), 'session.jsonl')
  }

  private async loadScope(scope: MemoryScope): Promise<MemoryEntry[]> {
    const cached = this.cache.get(scope)
    if (cached) return cached
    const entries: MemoryEntry[] = []
    try {
      const content = await readFile(this.fileFor(scope), 'utf8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as MemoryEntry
          if (entry && typeof entry.id === 'string' && entry.scope === scope) {
            entries.push(normalizeEntry(entry))
          }
        } catch {
          // Skip malformed lines so one bad record never breaks the store.
        }
      }
    } catch (error) {
      if (!isEnoentError(error)) throw error
    }
    this.cache.set(scope, entries)
    // Vector embeddings live in the persistent Chroma store (per collection),
    // so there is no in-memory ANN index to rebuild on startup.
    return entries
  }

  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    if (!this.loaded) {
      await this.loadScope('global')
      await this.loadScope('session')
      this.loaded = true
    }
    return [...(await this.loadScope(scope))]
  }

  async get(scope: MemoryScope, id: string): Promise<MemoryEntry | null> {
    const entries = await this.list(scope)
    return entries.find(entry => entry.id === id) ?? null
  }

  async add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'stage'>): Promise<MemoryEntry> {
    const now = new Date().toISOString()
    const full: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      stage: 'active',
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      updatedAt: now,
    }
    const entries = await this.list(entry.scope)
    entries.unshift(full)
    if (entries.length > this.maxEntriesPerScope) {
      entries.length = this.maxEntriesPerScope
    }
    this.cache.set(entry.scope, entries)
    if (full.embedding && full.embedding.length > 0) {
      await this.chromaIndex?.add(entry.scope, full.id, full.embedding)
    }
    await this.persistScope(entry.scope, entries)
    return full
  }

  async remove(scope: MemoryScope, id: string): Promise<boolean> {
    const entries = await this.list(scope)
    const next = entries.filter(entry => entry.id !== id)
    if (next.length === entries.length) return false
    this.cache.set(scope, next)
    await this.chromaIndex?.remove(id)
    await this.persistScope(scope, next)
    return true
  }

  /** Update content/metadata/embedding/stage of one entry. */
  async update(
    scope: MemoryScope,
    id: string,
    patch: {
      content?: string
      metadata?: MemoryMetadata
      embedding?: number[] | null
      stage?: MemoryStage
    },
  ): Promise<MemoryEntry | null> {
    const entries = await this.list(scope)
    const index = entries.findIndex(entry => entry.id === id)
    if (index === -1) return null
    const entry = entries[index]
    const next: MemoryEntry = {
      ...entry,
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.metadata !== undefined ? { metadata: { ...entry.metadata, ...patch.metadata } } : {}),
      ...(patch.embedding !== undefined ? { embedding: patch.embedding } : {}),
      ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
      updatedAt: new Date().toISOString(),
    }
    if (patch.embedding !== undefined) {
      await this.chromaIndex?.remove(id)
      if (patch.embedding && patch.embedding.length > 0) {
        await this.chromaIndex?.add(scope, id, patch.embedding)
      }
    }
    entries[index] = next
    // Keep the in-memory cache in sync so later reads see the update.
    this.cache.set(scope, entries)
    await this.persistScope(scope, entries)
    return next
  }

  /** Record a retrieval: bump accessCount and refresh lastAccessedAt. */
  async touch(scope: MemoryScope, id: string): Promise<void> {
    const entries = await this.list(scope)
    const entry = entries.find(entry => entry.id === id)
    if (!entry) return
    entry.lastAccessedAt = new Date().toISOString()
    entry.accessCount = (entry.accessCount ?? 0) + 1
    await this.persistScope(scope, entries)
  }

  /**
   * Batch-mutate a scope in a single persist (used by lifecycle GC): the
   * updater returns the next entry list plus ids to remove.
   */
  async mutate(
    scope: MemoryScope,
    updater: (entries: MemoryEntry[]) => { entries: MemoryEntry[]; removedIds: string[] },
  ): Promise<number> {
    const entries = await this.list(scope)
    const { entries: next, removedIds } = updater(entries)
    const changed =
      removedIds.length > 0 || JSON.stringify(next) !== JSON.stringify(entries)
    if (!changed) return 0
    this.cache.set(scope, next)
    for (const id of removedIds) {
      await this.chromaIndex?.remove(id)
    }
    await this.persistScope(scope, next)
    return removedIds.length
  }

  /** Remove all entries of a scope whose metadata matches a predicate. */
  async removeWhere(scope: MemoryScope, predicate: (entry: MemoryEntry) => boolean): Promise<number> {
    const entries = await this.list(scope)
    const removed = entries.filter(predicate)
    if (removed.length === 0) return 0
    const next = entries.filter(entry => !predicate(entry))
    this.cache.set(scope, next)
    for (const entry of removed) {
      await this.chromaIndex?.remove(entry.id)
    }
    await this.persistScope(scope, next)
    return removed.length
  }

  /** Remove the oldest entries of a scope beyond the configured cap. */
  async prune(scope: MemoryScope): Promise<number> {
    const entries = await this.list(scope)
    if (entries.length <= this.maxEntriesPerScope) return 0
    const removed = entries.length - this.maxEntriesPerScope
    const next = entries.slice(0, this.maxEntriesPerScope)
    this.cache.set(scope, next)
    await this.persistScope(scope, next)
    return removed
  }

  async clear(scope: MemoryScope): Promise<number> {
    const entries = await this.list(scope)
    this.cache.set(scope, [])
    for (const entry of entries) {
      await this.chromaIndex?.remove(entry.id)
    }
    await this.persistScope(scope, [])
    return entries.length
  }

  private async persistScope(scope: MemoryScope, entries: MemoryEntry[]): Promise<void> {
    const file = this.fileFor(scope)
    await mkdir(path.dirname(file), { recursive: true })
    const lines = entries.map(entry => JSON.stringify(entry)).join('\n')
    await writeFile(file, lines ? `${lines}\n` : '', 'utf8')
  }

  /**
   * Hybrid search: BM25 lexical ranking fused with Chroma vector similarity
   * via RRF (reciprocal rank fusion). BM25 stays a local in-memory index;
   * Chroma only serves vector storage & similarity search.
   */
  async hybridSearch(
    query: string,
    options: {
      scopes: MemoryScope[]
      stages?: MemoryStage[]
      topK: number
      rrfK: number
      queryEmbedding: number[] | null
    },
  ): Promise<Array<{ entry: MemoryEntry; score: number; bm25Score: number; vectorScore: number }>> {
    const { scopes, stages, topK, rrfK, queryEmbedding } = options
    const candidates: MemoryEntry[] = []
    for (const scope of scopes) {
      for (const entry of await this.list(scope)) {
        if (stages && stages.length > 0 && !stages.includes(entry.stage)) continue
        candidates.push(entry)
      }
    }
    if (candidates.length === 0) return []

    const entryById = new Map(candidates.map(entry => [entry.id, entry]))
    const bm25ScoreById = new Map<string, number>()

    // Channel 1: BM25 lexical ranking (local in-memory index).
    const bm25 = new BM25(candidates.map(entry => entry.content))
    const bm25Scores = bm25.scoreAll(query)
    candidates.forEach((entry, index) => bm25ScoreById.set(entry.id, bm25Scores[index]!))
    const bm25Ranked: Array<{ id: string; score: number }> = candidates
      .filter((_, index) => bm25Scores[index]! > 0)
      .sort((a, b) => (bm25ScoreById.get(b.id) ?? 0) - (bm25ScoreById.get(a.id) ?? 0))
      .slice(0, topK * 2)
      .map(entry => ({ id: entry.id, score: bm25ScoreById.get(entry.id) ?? 0 }))

    // Channel 2: Chroma vector similarity (persistent vector store).
    let vectorRanked: Array<{ id: string; score: number }> = []
    if (queryEmbedding && this.chromaIndex) {
      vectorRanked = await this.chromaIndex.search(queryEmbedding, scopes, topK * 2)
    }

    // RRF fusion of the two ranked channels (rank-based, no score normalization).
    const fused = rrfFuse([bm25Ranked, vectorRanked], rrfK).slice(0, topK)

    const scored: Array<{ entry: MemoryEntry; score: number; bm25Score: number; vectorScore: number }> = []
    for (const item of fused) {
      const entry = entryById.get(item.id)
      if (!entry) continue
      const vectorHit = vectorRanked.find(hit => hit.id === item.id)
      scored.push({
        entry,
        score: item.score,
        bm25Score: bm25ScoreById.get(item.id) ?? 0,
        vectorScore: vectorHit?.score ?? 0,
      })
    }
    return scored
  }
}

/** Build the default store directory under MINI_CODE_HOME (or ~/.mini-code). */
export function defaultMemoryDir(): string {
  return path.join(MINI_CODE_DIR, 'memory')
}

export function embedTextsLocal(texts: string[], dimensions = 384): number[][] {
  const vectors: number[][] = []
  for (const text of texts) {
    const vector = new Array<number>(dimensions).fill(0)
    let hash = 5381
    for (const term of tokenize(text)) {
      for (let i = 0; i < term.length; i++) {
        hash = ((hash << 5) + hash + term.charCodeAt(i)) >>> 0
      }
      vector[hash % dimensions] += 1
    }
    vectors.push(normalizeVector(vector))
  }
  return vectors
}
