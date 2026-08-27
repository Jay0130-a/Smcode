import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chunkText } from '../src/memory-ltm/chunker.js'
import { scanKnowledgeFiles } from '../src/memory-ltm/kb.js'
import { ChromaClient, LocalChromaCollection } from '../src/memory-ltm/chroma.js'
import { LongTermMemory } from '../src/memory-ltm/index.js'
import { createMemoryTools } from '../src/tools/memory.js'
import { ToolRegistry } from '../src/tool.js'
import { defaultMemoryConfig } from '../src/config.js'

describe('chunkText', () => {
  it('keeps short documents as a single chunk', () => {
    const chunks = chunkText('# Title\n\nShort document with enough text to pass the minimum length threshold.', { maxChars: 1200 })
    assert.equal(chunks.length, 1)
    assert.match(chunks[0].text, /Title/)
  })

  it('splits long sections by paragraphs', () => {
    const text = `# Section A\n\n${'a'.repeat(300)}\n\n${'b'.repeat(300)}\n\n${'c'.repeat(300)}`
    const chunks = chunkText(text, { maxChars: 500, minChars: 20 })
    assert.ok(chunks.length >= 3, `expected >= 3 chunks, got ${chunks.length}`)
  })

  it('applies overlap for window splits', () => {
    const long = 'word '.repeat(400) // 2000 chars
    const chunks = chunkText(long, { maxChars: 300, overlap: 60 })
    assert.ok(chunks.length > 1)
    // Consecutive chunks should share some text (overlap).
    const first = chunks[0].text
    const second = chunks[1].text
    const shared = first.split(' ').filter(word => second.includes(word)).length
    assert.ok(shared > 0, 'chunks should overlap')
  })

  it('assigns sequential chunk indexes', () => {
    const chunks = chunkText(`${'x'.repeat(500)}\n\n${'y'.repeat(500)}`, { maxChars: 200, minChars: 10 })
    chunks.forEach((chunk, i) => assert.equal(chunk.index, i))
  })
})

describe('scanKnowledgeFiles', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-kb-scan-'))
    await mkdir(path.join(dir, 'sub'), { recursive: true })
    await mkdir(path.join(dir, 'node_modules'), { recursive: true })
    await writeFile(path.join(dir, 'a.md'), '# A\ncontent here')
    await writeFile(path.join(dir, 'sub', 'b.txt'), 'text file')
    await writeFile(path.join(dir, 'c.json'), '{"ignored": true}')
    await writeFile(path.join(dir, 'node_modules', 'skip.js'), 'should be ignored')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('finds supported extensions recursively and skips ignored dirs', async () => {
    const files = await scanKnowledgeFiles(dir)
    const relPaths = files.map(file => file.relPath).sort()
    assert.deepEqual(relPaths, ['a.md', 'sub/b.txt'])
  })
})

describe('chroma persistent store (local backend)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-chroma-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('add/query/delete round trip with cosine similarity', async () => {
    const collection = new LocalChromaCollection('memory', path.join(dir, 'memory'))
    await collection.add({
      ids: ['a', 'b'],
      embeddings: [[1, 0, 0], [0, 1, 0]],
      documents: ['alpha doc', 'beta doc'],
    })
    assert.equal(await collection.count(), 2)
    const hits = await collection.query({ queryEmbeddings: [[1, 0, 0]], topK: 1 })
    assert.equal(hits[0][0].id, 'a')
    assert.ok(hits[0][0].score > 0.99)
    await collection.deleteByIds(['a'])
    assert.equal(await collection.count(), 1)
  })

  it('survives reload from disk (persistence)', async () => {
    const dir2 = path.join(dir, 'knowledge')
    const first = new LocalChromaCollection('knowledge', dir2)
    await first.add({
      ids: ['k1'],
      embeddings: [[0, 1, 0, 0]],
      documents: ['persisted doc'],
    })
    const second = new LocalChromaCollection('knowledge', dir2)
    const hits = await second.query({ queryEmbeddings: [[0, 1, 0, 0]], topK: 1 })
    assert.equal(hits[0][0].id, 'k1')
    assert.equal(hits[0][0].document, 'persisted doc')
  })

  it('ChromaClient falls back to local store when http is unreachable', async () => {
    const client = await ChromaClient.create({
      baseDir: path.join(dir, 'chroma'),
      config: { url: 'http://127.0.0.1:1' }, // nothing listens here
      onError: () => {},
    })
    assert.ok(client)
    assert.equal(client.backend, 'local')
    const collection = await client.getOrCreateCollection('knowledge')
    assert.ok(collection)
    await collection.add({ ids: ['x'], embeddings: [[1, 0, 0]] })
    assert.equal(await collection.count(), 1)
  })
})

describe('LongTermMemory knowledge base', () => {
  let dir: string
  let kbDir: string
  let memory: LongTermMemory
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-kb-mem-'))
    kbDir = path.join(dir, 'kb')
    await mkdir(kbDir, { recursive: true })
    await writeFile(
      path.join(kbDir, 'guide.md'),
      '# Deployment Guide\n\n## Health Check\n\nThe service exposes /health returning 200 when healthy.\n\n## Rollback\n\nUse `npm run rollback` to revert the last release.',
    )
    const config = {
      ...defaultMemoryConfig(),
      enabled: true,
      maxEntriesPerScope: 1000,
      reranker: { enabled: true, provider: 'local' as const, topN: 20 },
    }
    memory = await LongTermMemory.create(config, { cwd: '/tmp/project', storeDir: dir, chromaDir: path.join(dir, 'chroma') })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('imports a directory knowledge base and retrieves chunks', async () => {
    const result = await memory.importKnowledgeBase(kbDir, { kbName: 'guide' })
    assert.ok(result.fileCount >= 1)
    assert.ok(result.chunkCount >= 1)

    const { hits } = await memory.search('health endpoint status', { topK: 5 })
    assert.ok(hits.length >= 1)
    const kbHit = hits.find(hit => hit.entry.scope === 'kb')
    assert.ok(kbHit, 'expected a kb-scope hit')
    assert.match(kbHit!.entry.content, /health/i)
    assert.equal(kbHit!.entry.metadata.kbName, 'guide')
    assert.ok(kbHit!.entry.metadata.sourceRelPath)
  })

  it('re-import replaces old chunks (idempotent)', async () => {
    const first = await memory.importKnowledgeBase(kbDir, { kbName: 'guide' })
    const second = await memory.importKnowledgeBase(kbDir, { kbName: 'guide' })
    assert.ok(second.replaced >= first.chunkCount)
    const entries = await memory.list({ scopes: ['kb'], limit: 100 })
    assert.equal(entries.length, second.chunkCount)
  })

  it('renders kb hits with source tags', async () => {
    await memory.importKnowledgeBase(kbDir, { kbName: 'guide' })
    const { hits } = await memory.search('rollback release', { topK: 5 })
    const text = memory.renderHits(hits)
    assert.match(text, /kb:guide.md/)
  })

  it('lists, removes and clears knowledge bases', async () => {
    await memory.importKnowledgeBase(kbDir, { kbName: 'guide' })
    const bases = await memory.listKnowledgeBases()
    assert.equal(bases.length, 1)
    assert.equal(bases[0].kbName, 'guide')
    assert.ok(bases[0].chunkCount >= 1)

    const removed = await memory.removeKnowledgeBase('guide')
    assert.ok(removed >= 1)
    assert.equal((await memory.listKnowledgeBases()).length, 0)

    await memory.importKnowledgeBase(kbDir, { kbName: 'guide' })
    const cleared = await memory.clearKnowledgeBase()
    assert.ok(cleared >= 1)
    const { hits } = await memory.search('health', { topK: 3, scopes: ['kb'] })
    assert.equal(hits.length, 0)
  })
})

describe('knowledge_retrieve tool', () => {
  let dir: string
  let kbDir: string
  let registry: ToolRegistry
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-kb-tool-'))
    kbDir = path.join(dir, 'kb')
    await mkdir(kbDir, { recursive: true })
    await writeFile(
      path.join(kbDir, 'api.md'),
      '# API Reference\n\n## Authentication\n\nSend an Authorization header with a Bearer token to every endpoint.',
    )
    const config = {
      ...defaultMemoryConfig(),
      enabled: true,
      maxEntriesPerScope: 1000,
      reranker: { enabled: true, provider: 'local' as const, topN: 20 },
    }
    const memory = await LongTermMemory.create(config, { cwd: '/tmp/project', storeDir: dir })
    await memory.importKnowledgeBase(kbDir, { kbName: 'api' })
    registry = new ToolRegistry(createMemoryTools({ memory }))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('registers and returns validated kb hits with source paths', async () => {
    const result = await registry.execute(
      'knowledge_retrieve',
      { query: 'authentication bearer token', topK: 3 },
      { cwd: '/tmp/project' },
    )
    assert.equal(result.ok, true)
    assert.match(result.output, /Bearer token/i)
    assert.match(result.output, /source=api.md#/)
    assert.match(result.output, /\[kb\]/)
  })

  it('rejects invalid input via the zod schema', async () => {
    const result = await registry.execute(
      'knowledge_retrieve',
      { query: '', topK: 3 },
      { cwd: '/tmp/project' },
    )
    assert.equal(result.ok, false)
    assert.match(result.output, /too_small|query/)
  })

  it('tolerates irrelevant queries without erroring', async () => {
    const result = await registry.execute(
      'knowledge_retrieve',
      { query: 'zzz nonexistent topic qqq', topK: 3, scope: 'kb' },
      { cwd: '/tmp/project' },
    )
    assert.equal(result.ok, true)
    assert.ok(!result.output.startsWith('ERROR'), 'should not report an error')
  })
})
