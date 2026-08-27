import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalReranker, ApiReranker } from '../src/memory-ltm/reranker.js'
import { LongTermMemory } from '../src/memory-ltm/index.js'
import { defaultMemoryConfig } from '../src/config.js'
import type { RerankCandidate } from '../src/memory-ltm/reranker.js'
import type { MemoryEntry } from '../src/memory-ltm/types.js'

function makeCandidate(content: string, fusedScore: number): RerankCandidate {
  return {
    entry: {
      id: content.slice(0, 8),
      scope: 'session',
      content,
      kind: 'explicit',
      metadata: {},
      embedding: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as MemoryEntry,
    score: fusedScore,
    bm25Score: fusedScore,
    vectorScore: 0,
  }
}

describe('LocalReranker', () => {
  it('promotes candidates covering more query terms', async () => {
    const reranker = new LocalReranker()
    const candidates = [
      makeCandidate('the agent loop calls tools and reviews file changes', 0.8),
      makeCandidate('tool calls happen inside the model tool model loop tool calls tools', 0.6),
      makeCandidate('bananas are yellow and quite tasty', 0.7),
    ]
    const reranked = await reranker.rerank({
      query: 'agent tool loop',
      candidates,
      topN: 2,
    })
    assert.equal(reranked.length, 2)
    assert.ok(reranked[0].rerankScore !== undefined)
    // The document covering more query terms should win despite a lower fused score.
    assert.match(reranked[0].entry.content, /agent loop calls tools/)
  })

  it('keeps the top-N limit', async () => {
    const reranker = new LocalReranker()
    const candidates = Array.from({ length: 10 }, (_, i) => makeCandidate(`doc ${i} about tools`, 0.5))
    const reranked = await reranker.rerank({ query: 'tools', candidates, topN: 3 })
    assert.equal(reranked.length, 3)
  })
})

describe('ApiReranker', () => {
  it('throws on request failure (caller degrades to local)', async () => {
    // Point at a closed port; expect a fetch failure.
    const reranker = new ApiReranker({ baseUrl: 'http://127.0.0.1:1', model: 'rerank-model' })
    await assert.rejects(() =>
      reranker.rerank({ query: 'q', candidates: [makeCandidate('doc', 0.5)], topN: 1 }),
    )
  })
})

describe('LongTermMemory.search with reranker', () => {
  let dir: string
  let memory: LongTermMemory
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-rerank-'))
    const config = {
      ...defaultMemoryConfig(),
      enabled: true,
      maxEntriesPerScope: 100,
      reranker: { enabled: true, provider: 'local' as const, topN: 10 },
    }
    memory = await LongTermMemory.create(config, { cwd: '/tmp/project', storeDir: dir })
    await memory.remember({ content: 'the agent loop calls tools and reviews file changes', scope: 'session' })
    await memory.remember({ content: 'bananas are yellow and quite tasty', scope: 'session' })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns reranked hits with rerankScore', async () => {
    const { hits } = await memory.search('agent tool loop', { topK: 3 })
    assert.ok(hits.length >= 1)
    assert.ok(hits[0].rerankScore !== undefined, 'rerankScore should be present')
    assert.match(hits[0].entry.content, /agent loop/)
    assert.equal(memory.rerankerName, 'local')
  })

  it('skips reranking when disabled', async () => {
    const config = {
      ...defaultMemoryConfig(),
      enabled: true,
      maxEntriesPerScope: 100,
      reranker: { enabled: false, provider: 'local' as const, topN: 10 },
    }
    const plain = await LongTermMemory.create(config, { cwd: '/tmp/project', storeDir: dir })
    const { hits } = await plain.search('agent tool loop', { topK: 3 })
    assert.ok(hits[0].rerankScore === undefined)
  })
})
