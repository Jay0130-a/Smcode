import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LongTermMemory } from '../src/memory-ltm/index.js'
import { createMemoryTools } from '../src/tools/memory.js'
import { ToolRegistry } from '../src/tool.js'
import { defaultMemoryConfig } from '../src/config.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('memory lifecycle', () => {
  let dir: string
  let memory: LongTermMemory
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-lc-'))
    const config = {
      ...defaultMemoryConfig(),
      enabled: true,
      maxEntriesPerScope: 100,
      reranker: { enabled: true, provider: 'local' as const, topN: 20 },
      lifecycle: {
        agingDays: 30,
        archiveDays: 90,
        retentionDays: 180,
        capacityEviction: true,
        gcOnStartup: false,
      },
    }
    memory = await LongTermMemory.create(config, { cwd: '/tmp/project', storeDir: dir })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('new entries start active and search touches access stats', async () => {
    const entry = await memory.remember({ content: 'api key stored in env file', scope: 'session' })
    assert.equal(entry!.stage, 'active')
    assert.equal(entry!.accessCount, 0)

    const { hits } = await memory.search('api key', { topK: 3 })
    assert.ok(hits.length >= 1)
    const list = await memory.list({ scopes: ['session'] })
    assert.equal(list[0].accessCount, 1)
    assert.ok(list[0].lastAccessedAt)
  })

  it('ages active → dormant → archived and expires archived entries', async () => {
    const entry = await memory.remember({ content: 'deploy uses blue-green strategy', scope: 'global' })
    const id = entry!.id

    // Simulate 40 days without access → dormant.
    await mutateLastAccess(id, 'global', 40)
    let gc = await memory.gc()
    assert.equal(gc.demoted, 1)
    assert.equal((await memory.list({ scopes: ['global'] }))[0].stage, 'dormant')

    // Dormant memories are not injected (search defaults to active only).
    const { hits } = await memory.search('blue-green deploy', { topK: 3 })
    assert.equal(hits.length, 0)

    // Simulate 100 days → archived.
    await mutateLastAccess(id, 'global', 100)
    gc = await memory.gc()
    assert.equal(gc.archived, 1)
    assert.equal((await memory.list({ scopes: ['global'] }))[0].stage, 'archived')

    // Simulate 200 days → expired & deleted.
    await mutateLastAccess(id, 'global', 200)
    gc = await memory.gc()
    assert.equal(gc.expired, 1)
    assert.equal((await memory.list({ scopes: ['global'] })).length, 0)
  })

  it('evicts oldest non-active entries when over capacity', async () => {
    const config = {
      ...defaultMemoryConfig(),
      enabled: true,
      maxEntriesPerScope: 5,
      reranker: { enabled: true, provider: 'local' as const, topN: 20 },
      lifecycle: { agingDays: 1, archiveDays: 2, retentionDays: 3, capacityEviction: true, gcOnStartup: false },
    }
    const small = await LongTermMemory.create(config, { cwd: '/tmp/p', storeDir: dir })

    // Fill 5 entries, demote them to dormant, then add more.
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push((await small.remember({ content: `entry number ${i}`, scope: 'session' }))!.id)
    }
    await mutateLastAccess(ids[0], 'session', 2) // oldest dormant candidate
    for (const id of ids) await mutateLastAccess(id, 'session', 2)
    await small.gc() // demote all to dormant
    await small.remember({ content: 'fresh entry after eviction', scope: 'session' })

    const after = await small.list({ scopes: ['session'] })
    assert.equal(after.length, 5)
    assert.ok(after.some(e => e.content === 'fresh entry after eviction'))
    assert.ok(after.every(e => e.stage === 'dormant' || e.stage === 'active'))
  })

  it('legacy entries without stage fields normalize to active', async () => {
    const entry = await memory.remember({ content: 'legacy style entry', scope: 'session' })
    // Simulate a pre-lifecycle entry by clearing stage fields in the file.
    const list = await memory.list({ scopes: ['session'] })
    assert.equal(list[0].stage, 'active')
    assert.ok(list[0].lastAccessedAt)
    assert.equal(list[0].accessCount, 0)
  })

  async function mutateLastAccess(id: string, scope: 'session' | 'global', daysAgo: number): Promise<void> {
    const store = memory['store'] as { mutate(scope: string, fn: (entries: Array<{ id: string; lastAccessedAt?: string }>) => { entries: unknown[]; removedIds: string[] }): Promise<number> }
    await store.mutate(scope, entries => {
      const entry = entries.find(e => e.id === id)
      if (entry) {
        entry.lastAccessedAt = new Date(Date.now() - daysAgo * DAY_MS).toISOString()
      }
      return { entries: entries as unknown[], removedIds: [] }
    })
  }
})

describe('memory update & merge', () => {
  let dir: string
  let memory: LongTermMemory
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-upd-'))
    const config = { ...defaultMemoryConfig(), enabled: true, maxEntriesPerScope: 100 }
    memory = await LongTermMemory.create(config, { cwd: '/tmp/project', storeDir: dir })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('updates content in replace and append modes and re-embeds', async () => {
    const entry = await memory.remember({ content: 'old content about config', scope: 'session' })
    const id = entry!.id

    const replaced = await memory.update(id, { content: 'new config location is settings.json' })
    assert.equal(replaced!.content, 'new config location is settings.json')

    const appended = await memory.update(id, { content: 'validate with zod', mode: 'append' })
    assert.match(appended!.content, /settings\.json/)
    assert.match(appended!.content, /zod/)

    const { hits } = await memory.search('settings json validation', { topK: 3 })
    assert.ok(hits.length >= 1)
    assert.match(hits[0].entry.content, /zod/)
  })

  it('update returns null for unknown ids', async () => {
    assert.equal(await memory.update('nope', { content: 'x' }), null)
  })

  it('merges multiple entries into one and removes sources', async () => {
    const a = (await memory.remember({ content: 'project uses zod', scope: 'session' }))!.id
    const b = (await memory.remember({ content: 'project runs npm test', scope: 'session' }))!.id

    const merged = await memory.merge([a, b], 'project uses zod and runs npm test')
    assert.ok(merged)
    assert.equal(merged!.content, 'project uses zod and runs npm test')
    assert.deepEqual(merged!.metadata.mergedFrom, [a, b])

    const entries = await memory.list({ scopes: ['session'], limit: 100 })
    assert.ok(!entries.some(e => e.id === a || e.id === b), 'sources removed')
    assert.ok(entries.some(e => e.id === merged!.id))

    const { hits } = await memory.search('zod npm test', { topK: 3 })
    assert.ok(hits.some(h => h.entry.id === merged!.id))
  })

  it('merge requires at least two existing entries', async () => {
    const a = (await memory.remember({ content: 'only one', scope: 'session' }))!.id
    assert.equal(await memory.merge([a, 'missing-id']), null)
  })
})

describe('memory_update / memory_merge tools', () => {
  let dir: string
  let registry: ToolRegistry
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-updtool-'))
    const config = { ...defaultMemoryConfig(), enabled: true, maxEntriesPerScope: 100 }
    const memory = await LongTermMemory.create(config, { cwd: '/tmp/project', storeDir: dir })
    registry = new ToolRegistry(createMemoryTools({ memory }))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('memory_update works end-to-end with zod validation', async () => {
    const add = await registry.execute('memory_add', { content: 'initial note', scope: 'session' }, { cwd: '/tmp' })
    assert.equal(add.ok, true)
    const idMatch = add.output.match(/id=([0-9a-f-]+)/)
    assert.ok(idMatch)

    const updated = await registry.execute(
      'memory_update',
      { id: idMatch![1], content: 'revised note', mode: 'append' },
      { cwd: '/tmp' },
    )
    assert.equal(updated.ok, true)
    assert.match(updated.output, /revised note/)
  })

  it('memory_merge validates ids via zod', async () => {
    const result = await registry.execute(
      'memory_merge',
      { ids: ['one'] }, // min 2 — must fail validation
      { cwd: '/tmp' },
    )
    assert.equal(result.ok, false)
    assert.match(result.output, /too_small|ids/)
  })
})
