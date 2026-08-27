export type MemoryScope = 'session' | 'global' | 'kb'

export type MemoryKind = 'extracted' | 'explicit' | 'kb-doc'

/**
 * Lifecycle stage: active memories are injected into context; dormant ones
 * are searchable but no longer auto-injected; archived ones are only visible
 * via explicit search; expired archived memories are garbage-collected.
 */
export type MemoryStage = 'active' | 'dormant' | 'archived'

export type MemoryMetadata = {
  sessionId?: string
  cwd?: string
  toolNames?: string[]
  filePaths?: string[]
  sourceRole?: string
  /** Knowledge-base chunk metadata. */
  kbName?: string
  sourcePath?: string
  sourceRelPath?: string
  chunkIndex?: number
  /** Ids merged into this entry (set by memory_merge). */
  mergedFrom?: string[]
}

export type MemoryEntry = {
  id: string
  scope: MemoryScope
  content: string
  kind: MemoryKind
  metadata: MemoryMetadata
  /** Normalized embedding vector. null when embedding is disabled or failed. */
  embedding: number[] | null
  createdAt: string
  updatedAt: string
  /** Lifecycle stage, defaults to 'active' for legacy entries. */
  stage: MemoryStage
  /** Last retrieval/update timestamp, used by the lifecycle aging logic. */
  lastAccessedAt?: string
  /** Retrieval count, used for capacity eviction (LRU-like). */
  accessCount?: number
}

export type HybridHit = {
  entry: MemoryEntry
  /** Fused score used for final ranking (0..1). */
  score: number
  bm25Score: number
  vectorScore: number
  /** Reranker score, present after the rerank stage. */
  rerankScore?: number
}

export type MemorySearchOptions = {
  topK?: number
  scopes?: MemoryScope[]
  /** Lifecycle stages to include; defaults to active + dormant. */
  stages?: MemoryStage[]
  bm25Weight?: number
  vectorWeight?: number
  /** RRF fusion rank constant (k in 1/(k+rank)); defaults to config rrfK=60. */
  rrfK?: number
  /** Minimum fused score to keep a hit (0..1). */
  minScore?: number
}

export type MemoryListOptions = {
  scopes?: MemoryScope[]
  /** Lifecycle stage filter. */
  stages?: MemoryStage[]
  limit?: number
  offset?: number
}
