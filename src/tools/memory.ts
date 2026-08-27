import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import type { LongTermMemory } from '../memory-ltm/index.js'
import { truncateText } from '../memory-ltm/tokenize.js'
import type { MemoryEntry, MemoryScope } from '../memory-ltm/types.js'

/**
 * Long-term memory tools. Every input is validated with the tool's Zod
 * schema (via ToolRegistry.execute) and every structured result is validated
 * again with the per-tool output schema before being stringified.
 */

const scopeSchema = z.enum(['session', 'global', 'kb'])
const anyScopeSchema = z.enum(['session', 'global', 'kb', 'all'])

// --- output schemas (runtime validation of returned data) ---
const memoryEntryOutputSchema = z.object({
  id: z.string(),
  scope: scopeSchema,
  content: z.string(),
  createdAt: z.string(),
})

const memorySearchHitSchema = z.object({
  id: z.string(),
  scope: scopeSchema,
  content: z.string(),
  score: z.number(),
  rerankScore: z.number().optional(),
})

const memoryListOutputSchema = z.object({
  entries: z.array(z.object({ id: z.string(), scope: scopeSchema, content: z.string(), createdAt: z.string() })),
})

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateOutput<T>(schema: z.ZodType<T>, value: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(value)
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: `internal output validation failed: ${parsed.error.message}` }
}

export function createMemoryTools(args: { memory: LongTermMemory | null }): ToolDefinition<unknown>[] {
  const { memory } = args

  const disabledResult = (toolName: string): ToolResult =>
    ({ ok: false, output: `${toolName}: long-term memory is not enabled. Set "memory.enabled": true in ~/.mini-code/settings.json.` })

  const addTool: ToolDefinition<{ content: string; scope: MemoryScope }> = {
    name: 'memory_add',
    description:
      'Write a piece of long-term memory (scope=session is project-local, scope=global is cross-project) that will be recalled in future conversations via hybrid retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        scope: { type: 'string', enum: ['session', 'global'] },
      },
      required: ['content'],
    },
    schema: z.object({
      content: z.string().min(1).max(4000),
      scope: scopeSchema.default('session'),
    }),
    async run(input) {
      if (!memory) return disabledResult('memory_add')
      try {
        const entry = await memory.remember({
          content: input.content,
          scope: input.scope,
          kind: 'explicit',
        })
        if (!entry) {
          return { ok: true, output: 'Memory skipped (duplicate or empty content).' }
        }
        const checked = validateOutput(memoryEntryOutputSchema, {
          id: entry.id,
          scope: entry.scope,
          content: entry.content,
          createdAt: entry.createdAt,
        })
        if (!checked.ok) return { ok: false, output: checked.error }
        return {
          ok: true,
          output: `Memory saved: id=${checked.data.id} scope=${checked.data.scope}\n${checked.data.content}`,
        }
      } catch (error) {
        return { ok: false, output: `memory_add failed: ${formatError(error)}` }
      }
    },
  }

  const searchTool: ToolDefinition<{ query: string; topK: number; scope: 'session' | 'global' | 'kb' | 'all' }> = {
    name: 'memory_search',
    description:
      'Knowledge-base retrieval tool: hybrid BM25 keyword + vector similarity search, fused and reranked, returning the top relevant memory snippets for the model.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        topK: { type: 'number' },
        scope: { type: 'string', enum: ['session', 'global', 'all'] },
      },
      required: ['query'],
    },
    schema: z.object({
      query: z.string().min(1).max(500),
      topK: z.number().int().min(1).max(20).default(5),
      scope: anyScopeSchema.default('all'),
    }),
    async run(input) {
      if (!memory) return disabledResult('memory_search')
      try {
        const scopes: MemoryScope[] = input.scope === 'all' ? ['session', 'global', 'kb'] : [input.scope]
        const { hits } = await memory.search(input.query, {
          topK: input.topK,
          scopes,
          // Searchable stages: active + dormant (archived needs explicit lifecycle tools).
          stages: ['active', 'dormant'],
        })
        const outputSchema = z.object({ hits: z.array(memorySearchHitSchema) })
        const checked = validateOutput(outputSchema, {
          hits: hits.map(hit => ({
            id: hit.entry.id,
            scope: hit.entry.scope,
            content: hit.entry.content,
            score: hit.score,
            rerankScore: hit.rerankScore,
          })),
        })
        if (!checked.ok) return { ok: false, output: checked.error }
        if (checked.data.hits.length === 0) {
          return { ok: true, output: 'No memories found for the query.' }
        }
        const lines = checked.data.hits.map(
          (hit, index) =>
            `#${index + 1} [${hit.scope}] (score=${hit.score.toFixed(3)}${hit.rerankScore !== undefined ? `, rerank=${hit.rerankScore.toFixed(3)}` : ''}) ${hit.id}\n${hit.content}`,
        )
        return { ok: true, output: lines.join('\n\n') }
      } catch (error) {
        return { ok: false, output: `memory_search failed: ${formatError(error)}` }
      }
    },
  }

  const deleteTool: ToolDefinition<{ id: string }> = {
    name: 'memory_delete',
    description: 'Delete a long-term memory entry by its id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
    schema: z.object({
      id: z.string().min(1),
    }),
    async run(input) {
      if (!memory) return disabledResult('memory_delete')
      try {
        const deleted = await memory.forget(input.id)
        return {
          ok: true,
          output: deleted ? `Memory ${input.id} deleted.` : `Memory ${input.id} not found.`,
        }
      } catch (error) {
        return { ok: false, output: `memory_delete failed: ${formatError(error)}` }
      }
    },
  }

  const listTool: ToolDefinition<{ scope: 'session' | 'global' | 'kb' | 'all'; limit: number }> = {
    name: 'memory_list',
    description: 'List stored long-term memories (newest first).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'global', 'all'] },
        limit: { type: 'number' },
      },
    },
    schema: z.object({
      scope: anyScopeSchema.default('all'),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    async run(input) {
      if (!memory) return disabledResult('memory_list')
      try {
        const scopes: MemoryScope[] = input.scope === 'all' ? ['session', 'global'] : [input.scope]
        const entries = await memory.list({ scopes, limit: input.limit })
        const checked = validateOutput(memoryListOutputSchema, {
          entries: entries.map((entry: MemoryEntry) => ({
            id: entry.id,
            scope: entry.scope,
            content: entry.content,
            createdAt: entry.createdAt,
          })),
        })
        if (!checked.ok) return { ok: false, output: checked.error }
        if (checked.data.entries.length === 0) {
          return { ok: true, output: 'No memories stored.' }
        }
        const lines = checked.data.entries.map(
          entry => `[${entry.scope}] ${entry.id} (${entry.createdAt})\n${entry.content}`,
        )
        return { ok: true, output: lines.join('\n\n') }
      } catch (error) {
        return { ok: false, output: `memory_list failed: ${formatError(error)}` }
      }
    },
  }

  const kbImportTool: ToolDefinition<{ dir: string; kbName?: string; maxCharsPerChunk?: number; chunkOverlap?: number }> = {
    name: 'kb_import',
    description:
      'Import a local directory as a knowledge base: scan supported text files (.md/.txt/.rst/...), chunk them with the built-in chunker, vectorize, and store into the vector store for hybrid retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        kbName: { type: 'string' },
        maxCharsPerChunk: { type: 'number' },
        chunkOverlap: { type: 'number' },
      },
      required: ['dir'],
    },
    schema: z.object({
      dir: z.string().min(1),
      kbName: z.string().min(1).max(100).optional(),
      maxCharsPerChunk: z.number().int().min(100).max(8000).optional(),
      chunkOverlap: z.number().int().min(0).max(1000).optional(),
    }),
    async run(input) {
      if (!memory) return disabledResult('kb_import')
      try {
        const result = await memory.importKnowledgeBase(input.dir, {
          kbName: input.kbName,
          maxCharsPerChunk: input.maxCharsPerChunk,
          chunkOverlap: input.chunkOverlap,
        })
        const outputSchema = z.object({
          fileCount: z.number().int().min(0),
          chunkCount: z.number().int().min(0),
          added: z.number().int().min(0),
          replaced: z.number().int().min(0),
        })
        const checked = validateOutput(outputSchema, result)
        if (!checked.ok) return { ok: false, output: checked.error }
        return {
          ok: true,
          output: `Knowledge base imported: ${checked.data.fileCount} files → ${checked.data.chunkCount} chunks (added=${checked.data.added}, replaced=${checked.data.replaced}).`,
        }
      } catch (error) {
        return { ok: false, output: `kb_import failed: ${formatError(error)}` }
      }
    },
  }

  const knowledgeRetrieveTool: ToolDefinition<{ query: string; topK: number; scope: 'kb' | 'session' | 'global' | 'all'; maxChars?: number }> = {
    name: 'knowledge_retrieve',
    description:
      'Retrieve the top-N most relevant document chunks (and optionally memory snippets) from the local knowledge base. Uses hybrid BM25 keyword + vector similarity retrieval with reranking. Returns each hit with its source path and scores.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        topK: { type: 'number' },
        scope: { type: 'string', enum: ['kb', 'session', 'global', 'all'] },
        maxChars: { type: 'number' },
      },
      required: ['query'],
    },
    schema: z.object({
      query: z.string().min(1).max(500),
      topK: z.number().int().min(1).max(20).default(5),
      scope: z.enum(['kb', 'session', 'global', 'all']).default('kb'),
      maxChars: z.number().int().min(200).max(20000).optional(),
    }),
    async run(input) {
      if (!memory) return disabledResult('knowledge_retrieve')
      try {
        const scopes: MemoryScope[] = input.scope === 'all' ? ['kb', 'session', 'global'] : [input.scope]
        const { hits } = await memory.search(input.query, { topK: input.topK, scopes })

        const hitSchema = z.object({
          id: z.string(),
          scope: z.enum(['kb', 'session', 'global']),
          content: z.string(),
          score: z.number(),
          rerankScore: z.number().optional(),
          source: z.string().optional(),
          chunkIndex: z.number().optional(),
        })
        const outputSchema = z.object({ query: z.string(), hits: z.array(hitSchema) })
        const budget = input.maxChars ?? 8000
        const formatted: Array<{
          id: string
          scope: 'kb' | 'session' | 'global'
          content: string
          score: number
          rerankScore?: number
          source?: string
          chunkIndex?: number
        }> = []
        let used = 0
        for (const hit of hits) {
          const content = truncateText(hit.entry.content, Math.max(200, budget - used))
          formatted.push({
            id: hit.entry.id,
            scope: hit.entry.scope,
            content,
            score: hit.score,
            rerankScore: hit.rerankScore,
            source: hit.entry.metadata.sourceRelPath ?? hit.entry.metadata.kbName,
            chunkIndex: hit.entry.metadata.chunkIndex,
          })
          used += content.length
          if (used >= budget) break
        }

        const checked = validateOutput(outputSchema, { query: input.query, hits: formatted })
        if (!checked.ok) return { ok: false, output: checked.error }
        if (checked.data.hits.length === 0) {
          return { ok: true, output: 'No knowledge found for the query.' }
        }
        const lines = checked.data.hits.map(hit => {
          const source = hit.source ? ` (source=${hit.source}${hit.chunkIndex !== undefined ? `#${hit.chunkIndex}` : ''})` : ''
          const rerank = hit.rerankScore !== undefined ? ` rerank=${hit.rerankScore.toFixed(3)}` : ''
          return `[${hit.scope}] ${hit.id} score=${hit.score.toFixed(3)}${rerank}${source}\n${hit.content}`
        })
        return { ok: true, output: lines.join('\n\n') }
      } catch (error) {
        return { ok: false, output: `knowledge_retrieve failed: ${formatError(error)}` }
      }
    },
  }

  const memoryUpdateTool: ToolDefinition<{ id: string; content: string; mode?: 'replace' | 'append' }> = {
    name: 'memory_update',
    description:
      'Update an existing long-term memory entry: mode=replace overwrites the content, mode=append appends new content. The entry is re-embedded and reactivated to stage=active.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        mode: { type: 'string', enum: ['replace', 'append'] },
      },
      required: ['id', 'content'],
    },
    schema: z.object({
      id: z.string().min(1),
      content: z.string().min(1).max(4000),
      mode: z.enum(['replace', 'append']).default('replace'),
    }),
    async run(input) {
      if (!memory) return disabledResult('memory_update')
      try {
        const updated = await memory.update(input.id, { content: input.content, mode: input.mode })
        if (!updated) {
          return { ok: false, output: `Memory ${input.id} not found.` }
        }
        const checked = validateOutput(memoryEntryOutputSchema, {
          id: updated.id,
          scope: updated.scope,
          content: updated.content,
          createdAt: updated.createdAt,
        })
        if (!checked.ok) return { ok: false, output: checked.error }
        return {
          ok: true,
          output: `Memory updated: id=${checked.data.id} scope=${checked.data.scope} mode=${input.mode}\n${checked.data.content}`,
        }
      } catch (error) {
        return { ok: false, output: `memory_update failed: ${formatError(error)}` }
      }
    },
  }

  const memoryMergeTool: ToolDefinition<{ ids: string[]; content?: string }> = {
    name: 'memory_merge',
    description:
      'Merge 2-10 memory entries into one new entry. Source entries are removed; optionally provide merged content, otherwise the sources are concatenated.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        content: { type: 'string' },
      },
      required: ['ids'],
    },
    schema: z.object({
      ids: z.array(z.string().min(1)).min(2).max(10),
      content: z.string().min(1).max(8000).optional(),
    }),
    async run(input) {
      if (!memory) return disabledResult('memory_merge')
      try {
        const merged = await memory.merge(input.ids, input.content)
        if (!merged) {
          return { ok: false, output: 'memory_merge requires at least 2 existing memory ids.' }
        }
        const checked = validateOutput(memoryEntryOutputSchema, {
          id: merged.id,
          scope: merged.scope,
          content: merged.content,
          createdAt: merged.createdAt,
        })
        if (!checked.ok) return { ok: false, output: checked.error }
        return {
          ok: true,
          output: `Merged ${input.ids.length} memories into id=${checked.data.id}:\n${checked.data.content}`,
        }
      } catch (error) {
        return { ok: false, output: `memory_merge failed: ${formatError(error)}` }
      }
    },
  }

  return [addTool, searchTool, deleteTool, listTool, kbImportTool, knowledgeRetrieveTool, memoryUpdateTool, memoryMergeTool]
}

type ToolResult = Awaited<ReturnType<ToolDefinition<never>['run']>>
