// Smoke test: business-doc KB import -> Chroma persistence -> RRF hybrid search
// -> knowledge_retrieve tool -> /index command path.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultMemoryConfig } from '../src/config.js'
import { LongTermMemory } from '../src/memory-ltm/index.js'
import { createMemoryTools } from '../src/tools/memory.js'
import { tryHandleLocalCommand } from '../src/cli-commands.js'
import { ToolRegistry } from '../src/tool.js'

const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-smoke-'))
const kbDir = path.join(root, 'docs')
await mkdir(kbDir, { recursive: true })
await writeFile(
  path.join(kbDir, 'onboarding.md'),
  '# 入职指南\n\n## VPN 接入\n新员工入职第一天需要申请 VPN 账号，接入内网后才能访问研发环境。\n\n## 报销流程\n差旅报销在 OA 系统提交，发票需要公司抬头，审批时限为 7 个工作日。',
)
await writeFile(
  path.join(kbDir, 'api.txt'),
  'API 规范：/v1/orders 创建订单，POST 请求，必填字段 customerId 与 amount。\n限流策略：单 IP 每分钟 100 次。',
)
await writeFile(path.join(kbDir, 'ignore.py'), 'print("source code must NOT be indexed")')

const config = {
  ...defaultMemoryConfig(),
  enabled: true,
  embedding: { provider: 'local', dimensions: 384 },
  chroma: { url: 'http://127.0.0.1:1' }, // unreachable -> local persistent store
  reranker: { enabled: true, provider: 'local', topN: 20 },
  rrfK: 60,
}

const memory = await LongTermMemory.create(config, {
  cwd: root,
  storeDir: path.join(root, 'memory'),
  chromaDir: path.join(root, 'chroma'),
})

// 1) /index command path
const indexOutput = await tryHandleLocalCommand('/index', {
  cwd: root,
  memory,
  knowledgeBasePath: kbDir,
})
console.log('[/index]\n' + indexOutput)
if (!/files → .*chunks/.test(indexOutput ?? '')) throw new Error('index command failed')

// 2) only md/txt indexed
const files = await memory.scanKnowledgeBase(kbDir)
console.log('[scanned files]', files.map(f => f.relPath))
if (files.some(f => f.relPath.endsWith('.py'))) throw new Error('source file leaked into KB')

// 3) hybrid RRF search (BM25 + Chroma)
const { hits, details } = await memory.search('报销流程需要什么', {
  topK: 3,
  scopes: ['kb'],
  includeDetails: true,
})
console.log('[hybrid hits]', hits.map(h => `${h.entry.metadata.sourceRelPath} score=${h.score.toFixed(3)} rerank=${h.rerankScore?.toFixed(3)}`))
if (hits.length === 0) throw new Error('no hybrid hits')
if (!details) throw new Error('no retrieval details')
console.log('[bm25Top]', details.bm25Top.map(d => d.id).slice(0, 3))
console.log('[vectorTop]', details.vectorTop.map(d => d.id).slice(0, 3))
console.log('[fusedTop(rrf)]', details.fusedTop.map(d => d.id).slice(0, 3))
if (!details.fusedTop[0]?.content.includes('报销')) throw new Error('RRF top hit wrong')

// 4) knowledge_retrieve tool (Zod schema + registry execution, from memory tools)
const kbTool = createMemoryTools({ memory }).find(t => t.name === 'knowledge_retrieve')
if (!kbTool) throw new Error('knowledge_retrieve tool not registered')
const registry = new ToolRegistry([kbTool])
const result = await registry.execute('knowledge_retrieve', { query: 'VPN 怎么接入', topK: 2 }, { cwd: root })
console.log('[knowledge_retrieve ok]', result.ok)
console.log(result.output.slice(0, 300))
if (!result.ok || !result.output.includes('VPN')) throw new Error('knowledge_retrieve failed')
const badInput = await registry.execute('knowledge_retrieve', { query: '', topK: 99 }, { cwd: root })
if (badInput.ok) throw new Error('zod should reject bad input')

// 5) Chroma persistence across instance reload
const memory2 = await LongTermMemory.create(config, {
  cwd: root,
  storeDir: path.join(root, 'memory'),
  chromaDir: path.join(root, 'chroma'),
})
const reloadHits = await memory2.search('发票抬头要求', { topK: 2, scopes: ['kb'] })
console.log('[after reload hits]', reloadHits.hits.map(h => h.entry.metadata.sourceRelPath))
if (reloadHits.hits.length === 0) throw new Error('chroma persistence lost after reload')
console.log('[chroma counts]', await memory2['store'].chromaIndex?.count())

await rm(root, { recursive: true, force: true })
console.log('\nSMOKE TEST PASSED')
