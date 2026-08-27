import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { tokenize, cosineSimilarity, normalizeVector, truncateText } from '../src/memory-ltm/tokenize.js'
import { BM25 } from '../src/memory-ltm/bm25.js'
import { LocalEmbeddingProvider } from '../src/memory-ltm/embedding.js'
import { MemoryStore } from '../src/memory-ltm/store.js'
import { extractMemoriesFromTurn } from '../src/memory-ltm/extract.js'
import { LongTermMemory } from '../src/memory-ltm/index.js'
import { defaultMemoryConfig } from '../src/config.js'
import type { ChatMessage } from '../src/types.js'

describe('tokenize', () => {
  it('splits english words and lowercases', () => {
    const tokens = tokenize('Hello World! Read README.md')
    assert.ok(tokens.includes('hello'))
    assert.ok(tokens.includes('world'))
    assert.ok(tokens.includes('read'))
  })

  it('produces CJK character bigrams', () => {
    const tokens = tokenize('长期记忆')
    assert.ok(tokens.includes('长期'))
    assert.ok(tokens.includes('期记'))
    assert.ok(tokens.includes('记忆'))
  })
})

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors and 0 for orthogonal ones', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  })
})

describe('normalizeVector', () => {
  it('produces a unit vector', () => {
    const vector = normalizeVector([3, 4])
    assert.ok(Math.abs(Math.hypot(vector[0], vector[1]) - 1) < 1e-9)
  })
})

describe('truncateText', () => {
  it('truncates long text with a marker', () => {
    const text = truncateText('a'.repeat(200), 50)
    assert.ok(text.includes('[truncated]'))
    assert.ok(text.length < 80)
  })
})

describe('BM25', () => {
  it('ranks the relevant document above irrelevant ones', () => {
    const bm25 = new BM25([
      'The agent loop calls tools and reviews file changes',
      'Bananas are yellow and quite tasty',
      'tool calls happen inside the model tool model loop',
    ])
    const scores = bm25.scoreAll('agent tool loop')
    assert.ok(scores[0] > 0, 'relevant document should score > 0')
    assert.ok(scores[0] > scores[1], 'relevant doc should outrank unrelated doc')
    assert.ok(scores[2] > 0, 'tool loop doc should also score')
  })
})

describe('LocalEmbeddingProvider', () => {
  it('embeds similar texts closer than unrelated ones', async () => {
    const provider = new LocalEmbeddingProvider(128)
    const [a, b, c] = await provider.embed([
      'fix the login bug in auth module',
      'fix the login bug in auth module please',
      'the weather is sunny today',
    ])
    assert.ok(cosineSimilarity(a, b) > cosineSimilarity(a, c))
  })
})

describe('MemoryStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-mem-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('adds, lists and removes entries persistently', async () => {
    const store = new MemoryStore({ dir, cwd: '/tmp/project', maxEntriesPerScope: 100 })
    const added = await store.add({
      scope: 'session',
      content: 'remember me',
      kind: 'explicit',
      metadata: {},
      embedding: null,
    })
    assert.ok(added.id.length > 0)

    const list = await store.list('session')
    assert.equal(list.length, 1)
    assert.equal(list[0].content, 'remember me')

    const removed = await store.remove('session', added.id)
    assert.equal(removed, true)
    assert.equal((await store.list('session')).length, 0)
  })

  it('isolates session scope per project', async () => {
    const storeA = new MemoryStore({ dir, cwd: '/a', maxEntriesPerScope: 100 })
    const storeB = new MemoryStore({ dir, cwd: '/b', maxEntriesPerScope: 100 })
    await storeA.add({ scope: 'session', content: 'for A', kind: 'explicit', metadata: {}, embedding: null })
    assert.equal((await storeB.list('session')).length, 0)
    assert.equal((await storeA.list('session')).length, 1)
  })
})

describe('hybridSearch', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-hybrid-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('retrieves the matching memory via bm25+vector fusion', async () => {
    const store = new MemoryStore({ dir, cwd: '/tmp/project', maxEntriesPerScope: 100 })
    await store.add({ scope: 'session', content: 'user prefers 4-space indentation in typescript', kind: 'explicit', metadata: {}, embedding: null })
    await store.add({ scope: 'global', content: 'remember to run npm test before shipping', kind: 'explicit', metadata: {}, embedding: null })

    const provider = new LocalEmbeddingProvider(128)
    const [queryEmbedding] = await provider.embed(['indentation style'])
    const hits = await store.hybridSearch('indentation style typescript', {
      scopes: ['session', 'global'],
      topK: 5,
      bm25Weight: 0.5,
      vectorWeight: 0.5,
      queryEmbedding,
    })
    assert.ok(hits.length > 0)
    assert.match(hits[0].entry.content, /indentation/)
  })
})

describe('extractMemoriesFromTurn', () => {
  it('extracts task, file-change and lesson memories', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'add a health endpoint to server.ts' },
      { role: 'assistant_tool_call', toolUseId: '1', toolName: 'write_file', input: { path: 'server.ts' } },
      { role: 'tool_result', toolUseId: '1', toolName: 'write_file', content: 'written', isError: false },
      { role: 'assistant_tool_call', toolUseId: '2', toolName: 'run_command', input: { command: 'npm test' } },
      { role: 'tool_result', toolUseId: '2', toolName: 'run_command', content: 'command not found', isError: true },
      { role: 'assistant', content: 'Done. Added /health endpoint.' },
    ]
    const memories = extractMemoriesFromTurn({ messages, cwd: '/tmp', sessionId: 's1' })
    assert.ok(memories.some(m => m.content.includes('[TASK]')))
    assert.ok(memories.some(m => m.content.includes('[FILE CHANGES]') && m.content.includes('server.ts')))
    assert.ok(memories.some(m => m.content.includes('[LESSON]') && m.scope === 'global'))
  })
})

describe('LongTermMemory', () => {
  let dir: string
  let memory: LongTermMemory
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-ltm-'))
    const config = { ...defaultMemoryConfig(), enabled: true, maxEntriesPerScope: 100 }
    memory = await LongTermMemory.create(config, { cwd: '/tmp/project', storeDir: dir })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is disabled by default', async () => {
    const disabled = await LongTermMemory.create(defaultMemoryConfig(), { cwd: '/tmp', storeDir: dir })
    assert.equal(disabled.enabled, false)
    assert.equal(await disabled.remember({ content: 'x' }), null)
  })

  it('remembers, searches and forgets', async () => {
    const entry = await memory.remember({
      content: 'api base url is http://localhost:8080',
      scope: 'global',
    })
    assert.ok(entry)

    const { hits } = await memory.search('base url', { topK: 3 })
    assert.ok(hits.length >= 1)
    assert.match(hits[0].entry.content, /8080/)

    assert.equal(await memory.forget(entry!.id), true)
    assert.equal(await memory.forget(entry!.id), false)
  })

  it('skips duplicates', async () => {
    await memory.remember({ content: 'duplicate content here' })
    const second = await memory.remember({ content: 'duplicate content here' })
    assert.equal(second, null)
  })

  it('renders hits with an injection marker', async () => {
    await memory.remember({ content: 'project uses vitest for testing', scope: 'session' })
    const { hits } = await memory.search('testing', { topK: 3 })
    const text = memory.renderHits(hits)
    assert.ok(text.startsWith('## Recalled Long-Term Memories'))
    assert.match(text, /vitest/)
  })
})
