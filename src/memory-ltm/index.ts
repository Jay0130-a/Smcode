import type { MemoryConfig } from '../config.js'
import { MINI_CODE_DIR } from '../config.js'
import type { ChatMessage } from '../types.js'
import path from 'node:path'
import {
  createEmbeddingProvider,
  embedTexts,
  type EmbeddingProvider,
} from './embedding.js'
import { MemoryStore, defaultMemoryDir } from './store.js'
import { extractMemoriesFromTurn } from './extract.js'
import { computeRetrievalDetails, type RetrievalDetails } from './hybrid.js'
import { createReranker, type Reranker } from './reranker.js'
import { ChromaClient, ChromaIndex } from './chroma.js'
import { scanKnowledgeFiles, buildKbEntries, type KnowledgeBaseOptions } from './kb.js'
import { cosineSimilarity, truncateText } from './tokenize.js'
import type {
  HybridHit,
  MemoryEntry,
  MemoryKind,
  MemoryListOptions,
  MemoryMetadata,
  MemoryScope,
  MemorySearchOptions,
  MemoryStage,
} from './types.js'

const MAX_MEMORY_CONTENT_CHARS = 4000
const MAX_RENDER_CHARS = 600
const DUPLICATE_SIMILARITY = 0.95

export type MemorySearchResult = {
  hits: HybridHit[]
  details?: RetrievalDetails
  queryEmbedding: number[] | null
}

export type GcResult = {
  demoted: number
  archived: number
  expired: number
  evicted: number
}

export type UpdateMemoryArgs = {
  content: string
  mode?: 'replace' | 'append'
  metadata?: MemoryMetadata
}

/**
 * Long-term memory facade (RAG). Combines a JSONL-backed metadata store with
 * ChromaDB vector persistence and BM25 + vector hybrid retrieval fused with
 * RRF. Chroma and embedding failures degrade to BM25-only retrieval and never
 * interrupt the agent turn.
 */
export class LongTermMemory {
  private constructor(
    private readonly store: MemoryStore,
    private readonly embedding: EmbeddingProvider | null,
    readonly config: MemoryConfig,
    private readonly cwd: string,
    private readonly reranker: Reranker,
    private readonly chromaIndex: ChromaIndex,
    private reportError: (message: string) => void = () => {},
  ) {}

  static async create(
    config: MemoryConfig,
    options: { cwd: string; storeDir?: string; chromaDir?: string } = { cwd: process.cwd() },
  ): Promise<LongTermMemory> {
    const reportError = (_message: string): void => {
      // Wired to the trace recorder by the caller via setErrorReporter.
    }
    let embedding: EmbeddingProvider | null = null
    try {
      embedding = createEmbeddingProvider(config.embedding)
    } catch {
      embedding = null
    }
    const chromaDir = options.chromaDir ?? path.join(MINI_CODE_DIR, 'chroma')
    let chromaClient: ChromaClient | null = null
    try {
      chromaClient = await ChromaClient.create({
        baseDir: chromaDir,
        config: config.chroma ?? {},
        onError: reportError,
      })
    } catch {
      chromaClient = null
    }
    const chromaIndex = new ChromaIndex(chromaClient)
    const store = new MemoryStore({
      dir: options.storeDir ?? defaultMemoryDir(),
      cwd: options.cwd,
      maxEntriesPerScope: config.maxEntriesPerScope,
      chromaIndex,
    })
    const reranker = createReranker(config.reranker)
    return new LongTermMemory(store, embedding, config, options.cwd, reranker, chromaIndex, reportError)
  }

  get enabled(): boolean {
    return this.config.enabled === true
  }

  get embeddingProviderName(): string {
    return this.embedding?.name ?? 'none'
  }

  get rerankerName(): string {
    return this.reranker.name
  }

  /** 'http' when a real Chroma server is used, 'local' for the persistent store, 'disabled' on failure. */
  get vectorBackend(): string {
    return this.chromaIndex.backend
  }

  /** Attach a trace-log reporter so embedding/chroma degradations are recorded. */
  setErrorReporter(reporter: (message: string) => void): void {
    this.reportError = reporter
  }

  private async embed(texts: string[]): Promise<number[] | null> {
    const vectors = await embedTexts(this.embedding, texts, this.reportError)
    if (!vectors || vectors.length === 0) return null
    return vectors[0] ?? null
  }

  /** Write one memory entry. Returns null when memory is disabled. */
  async remember(args: {
    content: string
    scope?: MemoryScope
    kind?: MemoryKind
    metadata?: MemoryMetadata
  }): Promise<MemoryEntry | null> {
    if (!this.enabled) return null
    const content = truncateText(args.content.trim(), MAX_MEMORY_CONTENT_CHARS)
    if (!content) return null

    const scope = args.scope ?? this.config.defaultScope ?? 'session'
    if (await this.isDuplicate(scope, content)) return null

    const embedding = await this.embed([content])
    return this.store.add({
      scope,
      content,
      kind: args.kind ?? 'explicit',
      metadata: args.metadata ?? {},
      embedding,
    })
  }

  /** Hybrid BM25 + Chroma vector search (RRF fusion) with optional trace details. */
  async search(
    query: string,
    options: MemorySearchOptions & { includeDetails?: boolean } = {},
  ): Promise<MemorySearchResult> {
    const scopes = options.scopes ?? ['session', 'global', 'kb']
    const stages = options.stages ?? ['active']
    const topK = options.topK ?? this.config.topK ?? 5
    const rrfK = options.rrfK ?? this.config.rrfK ?? 60
    const queryEmbedding = await this.embed([query])

    const entries: MemoryEntry[] = []
    for (const scope of scopes) {
      for (const entry of await this.store.list(scope)) {
        if (stages.length > 0 && !stages.includes(entry.stage)) continue
        entries.push(entry)
      }
    }

    // Stage 1: fuse BM25 + vector candidates via RRF (retrieve more than needed).
    const candidateTopK = Math.min(
      Math.max(topK * 3, 10),
      this.config.reranker?.topN ?? 20,
    )
    const candidates = await this.store.hybridSearch(query, {
      scopes,
      stages,
      topK: candidateTopK,
      rrfK,
      queryEmbedding,
    })

    // Stage 2: rerank fused candidates, then return top-N.
    const rerankEnabled = this.config.reranker?.enabled !== false
    const hits = rerankEnabled
      ? await this.reranker.rerank({ query, candidates, topN: topK })
      : candidates.slice(0, topK)

    const details = options.includeDetails
      ? computeRetrievalDetails({
          entries,
          query,
          queryEmbedding,
          bm25Weight: 0.5,
          vectorWeight: 0.5,
          topK,
          rrfK,
        })
      : undefined

    // Lifecycle touch: record retrieval so aging/capacity logic has signal.
    for (const hit of hits) {
      await this.store.touch(hit.entry.scope, hit.entry.id)
    }

    return { hits, details, queryEmbedding }
  }

  /** Delete a memory entry by id (checks both scopes). */
  async forget(id: string): Promise<boolean> {
    if (!this.enabled) return false
    const globalRemoved = await this.store.remove('global', id)
    if (globalRemoved) return true
    return this.store.remove('session', id)
  }

  /** List memory entries, newest first. */
  async list(options: MemoryListOptions = {}): Promise<MemoryEntry[]> {
    if (!this.enabled) return []
    const scopes = options.scopes ?? ['session', 'global']
    const stages = options.stages
    const entries: MemoryEntry[] = []
    for (const scope of scopes) {
      for (const entry of await this.store.list(scope)) {
        if (stages && stages.length > 0 && !stages.includes(entry.stage)) continue
        entries.push(entry)
      }
    }
    entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    const offset = options.offset ?? 0
    return entries.slice(offset, offset + (options.limit ?? 50))
  }

  async count(): Promise<{ session: number; global: number; kb: number }> {
    return {
      session: (await this.store.list('session')).length,
      global: (await this.store.list('global')).length,
      kb: (await this.store.list('kb')).length,
    }
  }

  /**
   * Import a local file directory as a knowledge base: scan supported text
   * files, chunk them (built-in markdown-aware chunker), vectorize, and store
   * each chunk as a kb-scope entry. Re-importing the same kbName replaces the
   * old chunks (idempotent).
   */
  async importKnowledgeBase(
    dir: string,
    options: KnowledgeBaseOptions = {},
  ): Promise<{ fileCount: number; chunkCount: number; added: number; replaced: number }> {
    const files = await scanKnowledgeFiles(dir, options)
    const kbName = options.kbName ?? path.basename(path.resolve(dir))

    // Idempotent re-import: drop old chunks of this kb first.
    const replaced = await this.store.removeWhere(
      'kb',
      entry => entry.metadata.kbName === kbName,
    )

    let added = 0
    for (const file of files) {
      const chunks = buildKbEntries({
        files: [file],
        kbName,
        cwd: this.cwd,
        maxCharsPerChunk: options.maxCharsPerChunk,
        chunkOverlap: options.chunkOverlap,
      })
      for (const chunk of chunks) {
        const embedding = await this.embed([chunk.content])
        const entry = await this.store.add({
          scope: 'kb',
          content: chunk.content,
          kind: 'kb-doc',
          metadata: chunk.metadata,
          embedding,
        })
        if (entry) added += 1
      }
    }
    return { fileCount: files.length, chunkCount: added, added, replaced }
  }

  /**
   * Update an existing session/global memory entry. mode='append' concatenates
   * new content to the old content; the entry is re-embedded and reset to
   * stage 'active'. Knowledge-base chunks are managed via re-import instead.
   */
  async update(id: string, args: UpdateMemoryArgs): Promise<MemoryEntry | null> {
    if (!this.enabled) return null
    for (const scope of ['session', 'global'] as const) {
      const entry = await this.store.get(scope, id)
      if (!entry) continue
      const nextContent =
        args.mode === 'append' ? `${entry.content}\n${args.content}` : args.content
      const embedding = await this.embed([nextContent])
      return this.store.update(scope, id, {
        content: nextContent,
        metadata: args.metadata,
        embedding,
        stage: 'active',
      })
    }
    return null
  }

  /**
   * Merge two or more session/global memories into one new entry. When
   * content is omitted the source contents are concatenated. The source
   * entries are removed; mergedFrom keeps provenance in metadata.
   */
  async merge(ids: string[], content?: string): Promise<MemoryEntry | null> {
    if (!this.enabled) return null
    const found: Array<{ scope: MemoryScope; entry: MemoryEntry }> = []
    for (const id of ids) {
      for (const scope of ['session', 'global'] as const) {
        const entry = await this.store.get(scope, id)
        if (entry) {
          found.push({ scope, entry })
          break
        }
      }
    }
    if (found.length < 2) return null

    const scope = found[0].entry.scope
    const mergedContent =
      content?.trim() || found.map(item => item.entry.content).join('\n\n')
    for (const item of found) {
      await this.store.remove(item.scope, item.entry.id)
    }
    const embedding = await this.embed([mergedContent])
    return this.store.add({
      scope,
      content: mergedContent,
      kind: 'explicit',
      metadata: {
        ...found[0].entry.metadata,
        mergedFrom: ids,
      },
      embedding,
    })
  }

  /**
   * Lifecycle garbage collection: age active→dormant→archived, delete expired
   * archived entries, and evict oldest-accessed non-active entries when the
   * scope cap is exceeded. Knowledge-base chunks are not aged.
   */
  async gc(): Promise<GcResult> {
    const result: GcResult = { demoted: 0, archived: 0, expired: 0, evicted: 0 }
    if (!this.enabled) return result
    const lifecycle = this.config.lifecycle ?? {}
    const agingDays = lifecycle.agingDays ?? 30
    const archiveDays = lifecycle.archiveDays ?? 90
    const retentionDays = lifecycle.retentionDays ?? 180
    const dayMs = 24 * 60 * 60 * 1000
    const now = Date.now()

    for (const scope of ['session', 'global'] as const) {
      await this.store.mutate(scope, entries => {
        const removedIds: string[] = []
        const next: MemoryEntry[] = []
        for (const entry of entries) {
          const lastAccess =
            entry.lastAccessedAt
              ? Date.parse(entry.lastAccessedAt)
              : Date.parse(entry.createdAt)
          const ageDays = Number.isFinite(lastAccess) ? (now - lastAccess) / dayMs : 0
          let stage: MemoryStage = entry.stage
          if (stage === 'active' && ageDays > agingDays) {
            stage = 'dormant'
            result.demoted += 1
          } else if (stage === 'dormant' && ageDays > archiveDays) {
            stage = 'archived'
            result.archived += 1
          }
          if (stage === 'archived' && ageDays > retentionDays) {
            removedIds.push(entry.id)
            result.expired += 1
            continue
          }
          next.push(stage === entry.stage ? entry : { ...entry, stage })
        }

        // Capacity eviction: drop oldest-accessed non-active entries first.
        if (lifecycle.capacityEviction !== false && next.length > (this.config.maxEntriesPerScope ?? 500)) {
          const removable = next
            .filter(entry => entry.stage !== 'active')
            .sort((a, b) => {
              const ta = a.lastAccessedAt ? Date.parse(a.lastAccessedAt) : Date.parse(a.createdAt)
              const tb = b.lastAccessedAt ? Date.parse(b.lastAccessedAt) : Date.parse(b.createdAt)
              return ta - tb
            })
          let overflow = next.length - (this.config.maxEntriesPerScope ?? 500)
          for (const entry of removable) {
            if (overflow <= 0) break
            const index = next.findIndex(item => item.id === entry.id)
            if (index !== -1) next.splice(index, 1)
            removedIds.push(entry.id)
            result.evicted += 1
            overflow -= 1
          }
        }
        return { entries: next, removedIds }
      })
    }
    return result
  }

  /** Scan-only: list files that would be imported from a directory. */
  async scanKnowledgeBase(dir: string, options: KnowledgeBaseOptions = {}): Promise<Array<{ relPath: string; chars: number }>> {
    const files = await scanKnowledgeFiles(dir, options)
    return files.map(file => ({ relPath: file.relPath, chars: file.content.length }))
  }

  /** Knowledge-base sources: name, imported files, chunk counts. */
  async listKnowledgeBases(): Promise<Array<{ kbName: string; fileCount: number; chunkCount: number }>> {
    const entries = await this.store.list('kb')
    const byName = new Map<string, { files: Set<string>; chunks: number }>()
    for (const entry of entries) {
      const name = entry.metadata.kbName ?? 'default'
      const group = byName.get(name) ?? { files: new Set<string>(), chunks: 0 }
      if (entry.metadata.sourcePath) group.files.add(entry.metadata.sourcePath)
      group.chunks += 1
      byName.set(name, group)
    }
    return [...byName.entries()]
      .map(([kbName, group]) => ({ kbName, fileCount: group.files.size, chunkCount: group.chunks }))
      .sort((a, b) => a.kbName.localeCompare(b.kbName))
  }

  /** Remove all kb chunks of one knowledge-base source. Returns removed count. */
  async removeKnowledgeBase(kbName: string): Promise<number> {
    return this.store.removeWhere('kb', entry => entry.metadata.kbName === kbName)
  }

  /** Remove every kb chunk. Returns removed count. */
  async clearKnowledgeBase(): Promise<number> {
    return this.store.clear('kb')
  }

  /**
   * Extract + persist memories at the end of a turn. Returns the entries
   * that were actually written (duplicates are skipped).
   */
  async extractFromTurn(args: {
    messages: ChatMessage[]
    sessionId?: string
  }): Promise<MemoryEntry[]> {
    if (!this.enabled || this.config.extractOnTurnEnd === false) return []
    const extracted = extractMemoriesFromTurn({
      messages: args.messages,
      cwd: this.cwd,
      sessionId: args.sessionId,
      defaultScope: this.config.defaultScope,
    })
    const written: MemoryEntry[] = []
    for (const memory of extracted) {
      const entry = await this.remember({ ...memory })
      if (entry) written.push(entry)
    }
    return written
  }

  /**
   * Render recalled hits into the text injected into the agent context.
   * The heading doubles as a marker so a previous injection can be replaced
   * on the next turn instead of accumulating.
   */
  renderHits(hits: HybridHit[], maxChars?: number): string {
    const budget = maxChars ?? this.config.maxInjectChars ?? 4000
    const lines: string[] = ['## Recalled Long-Term Memories']
    let used = lines[0].length
    for (const hit of hits) {
      const preview = truncateText(hit.entry.content, MAX_RENDER_CHARS)
      const tag =
        hit.entry.scope === 'kb'
          ? `kb:${hit.entry.metadata.sourceRelPath ?? hit.entry.metadata.kbName ?? 'doc'}#${hit.entry.metadata.chunkIndex ?? 0}`
          : hit.entry.scope
      const line = `[${tag}] ${preview}`
      if (used + line.length + 1 > budget) {
        lines.push('_更多记忆未注入（超出注入预算）。_')
        break
      }
      lines.push(line)
      used += line.length + 1
    }
    return lines.join('\n')
  }

  /** Marker prefix used to find/replace previous memory injections. */
  static injectionMarker(): string {
    return '## Recalled Long-Term Memories'
  }

  /** True when an entry with nearly identical content already exists. */
  private async isDuplicate(scope: MemoryScope, content: string): Promise<boolean> {
    const existing = await this.store.list(scope)
    if (existing.length === 0) return false
    for (const entry of existing) {
      if (entry.content === content) return true
      if (entry.embedding && entry.embedding.length > 0) {
        const candidate = await this.embed([content])
        if (candidate && cosineSimilarity(candidate, entry.embedding) >= DUPLICATE_SIMILARITY) {
          return true
        }
      }
    }
    return false
  }
}

export function isMemoryInjectionMessage(content: string): boolean {
  return content.startsWith(LongTermMemory.injectionMarker())
}
