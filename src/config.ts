import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { isEnoentError } from './utils/errors.js'

export type MiniCodeSettings = {
  env?: Record<string, string | number>
  model?: string
  maxOutputTokens?: number
  mcpServers?: Record<string, McpServerConfig>
  /** Long-term memory (RAG) settings. All features are disabled by default. */
  memory?: MemoryConfig
  /** Trace recording settings. Disabled by default. */
  trace?: TraceConfig
  /** LLM-as-Judge rubric evaluation settings. Disabled by default. */
  judge?: JudgeConfig
}

// ---------------------------------------------------------------------------
// Long-term memory (RAG) configuration — validated with Zod, default disabled.
// ---------------------------------------------------------------------------

export const memoryEmbeddingConfigSchema = z.object({
  /** 'api' = OpenAI-compatible /v1/embeddings endpoint (default, model=qwen3.7-text-embedding); 'local' = offline hash bag-of-words fallback. */
  provider: z.enum(['local', 'api']).optional(),
  /** Embedding model name, defaults to qwen3.7-text-embedding. */
  model: z.string().optional(),
  /** OpenAI-compatible embeddings base URL. Accepts both root (https://host) and /v1 (https://host/v1). */
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  dimensions: z.number().int().min(64).max(4096).optional(),
})
export type MemoryEmbeddingConfig = z.infer<typeof memoryEmbeddingConfigSchema>

/** ChromaDB connection settings. Chroma is used for vector storage & similarity search. */
export const chromaConfigSchema = z.object({
  /** Chroma server URL, e.g. http://127.0.0.1:8000. When unset/unreachable a Chroma-compatible local persistent store is used under ~/.mini-code/chroma/. */
  url: z.string().optional(),
  /** Request timeout in ms for Chroma HTTP calls. */
  timeoutMs: z.number().int().min(100).max(60000).optional(),
})
export type ChromaConfig = z.infer<typeof chromaConfigSchema>

export const memoryRerankerConfigSchema = z.object({
  /** Rerank fused candidates before returning top-N. Default true (follows memory.enabled). */
  enabled: z.boolean().optional(),
  provider: z.enum(['local', 'api']).optional(),
  /** API reranker model (required for provider=api). */
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  /** Number of fused candidates fed into the reranker. */
  topN: z.number().int().min(1).max(50).optional(),
})
export type MemoryRerankerConfig = z.infer<typeof memoryRerankerConfigSchema>

export const knowledgeBaseConfigSchema = z.object({
  /** Directories (relative to cwd) auto-imported as knowledge bases on startup. */
  dirs: z.array(z.string()).optional(),
  /** Business document directory (only .md/.txt files are indexed). Configured => RAG knowledge base is enabled. Default off. */
  path: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  ignoreDirs: z.array(z.string()).optional(),
  /** Chunk size in chars (alias chunk_size). */
  maxCharsPerChunk: z.number().int().min(100).max(8000).optional(),
  /** Chunk overlap in chars (alias chunk_overlap). */
  chunkOverlap: z.number().int().min(0).max(1000).optional(),
})
export type KnowledgeBaseConfig = z.infer<typeof knowledgeBaseConfigSchema>

export const memoryLifecycleConfigSchema = z.object({
  /** Days without access after which an active memory becomes dormant (not injected). */
  agingDays: z.number().int().min(1).max(3650).optional(),
  /** Days without access after which a dormant memory becomes archived. */
  archiveDays: z.number().int().min(1).max(3650).optional(),
  /** Days after which an archived memory is garbage-collected (deleted). */
  retentionDays: z.number().int().min(1).max(36500).optional(),
  /** Evict oldest accessed non-active entries when the scope cap is exceeded. */
  capacityEviction: z.boolean().optional(),
  /** Run garbage collection on startup (when memory.enabled). */
  gcOnStartup: z.boolean().optional(),
})
export type MemoryLifecycleConfig = z.infer<typeof memoryLifecycleConfigSchema>

export const memoryConfigSchema = z.object({
  enabled: z.boolean().optional(),
  topK: z.number().int().min(1).max(20).optional(),
  /** Inject recalled memories before every user turn (true) or only once per session (false). */
  injectEveryTurn: z.boolean().optional(),
  /** Max chars of recalled memory text injected into context per turn. */
  maxInjectChars: z.number().int().min(200).max(20000).optional(),
  /** Auto-extract memories at the end of each turn. */
  extractOnTurnEnd: z.boolean().optional(),
  defaultScope: z.enum(['session', 'global']).optional(),
  maxEntriesPerScope: z.number().int().min(10).max(100000).optional(),
  /** RRF fusion rank constant (k in 1/(k+rank)). */
  rrfK: z.number().int().min(1).max(200).optional(),
  /** Kept for back-compat; fused score weights are ignored under RRF fusion. */
  bm25Weight: z.number().min(0).max(1).optional(),
  vectorWeight: z.number().min(0).max(1).optional(),
  embedding: memoryEmbeddingConfigSchema.optional(),
  reranker: memoryRerankerConfigSchema.optional(),
  chroma: chromaConfigSchema.optional(),
  knowledgeBase: knowledgeBaseConfigSchema.optional(),
  lifecycle: memoryLifecycleConfigSchema.optional(),
})
export type MemoryConfig = z.infer<typeof memoryConfigSchema>

export const traceConfigSchema = z.object({
  enabled: z.boolean().optional(),
  /** Custom trace output directory. Defaults to ~/.mini-code/traces. */
  dir: z.string().optional(),
  maxFileEntries: z.number().int().min(10).max(100000).optional(),
})
export type TraceConfig = z.infer<typeof traceConfigSchema>

export const judgeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  /** Judge model name. Defaults to the main model when empty. */
  model: z.string().optional(),
  /** Optional reference answer template attached to every evaluation. */
  reference: z.string().optional(),
  maxScore: z.number().int().min(1).max(10).optional(),
})
export type JudgeConfig = z.infer<typeof judgeConfigSchema>

export function defaultMemoryConfig(): MemoryConfig {
  return {
    enabled: false,
    topK: 5,
    injectEveryTurn: true,
    maxInjectChars: 4000,
    extractOnTurnEnd: true,
    defaultScope: 'session',
    maxEntriesPerScope: 500,
    rrfK: 60,
    bm25Weight: 0.5,
    vectorWeight: 0.5,
    embedding: { provider: 'api', model: 'qwen3.7-text-embedding' },
    reranker: { enabled: true, provider: 'local', topN: 20 },
    chroma: { url: 'http://127.0.0.1:8000', timeoutMs: 5000 },
    knowledgeBase: {
      path: '',
      extensions: ['.md', '.txt'],
      ignoreDirs: ['.git', '.svn', 'node_modules', '.mini-code', '.claude', 'dist', 'build', 'out', 'coverage'],
      maxCharsPerChunk: 1200,
      chunkOverlap: 120,
    },
    lifecycle: {
      agingDays: 30,
      archiveDays: 90,
      retentionDays: 180,
      capacityEviction: true,
      gcOnStartup: true,
    },
  }
}

export function defaultTraceConfig(): TraceConfig {
  return { enabled: false, maxFileEntries: 2000 }
}

export function defaultJudgeConfig(): JudgeConfig {
  return { enabled: false, maxScore: 5 }
}

export function parseMemoryConfig(raw: unknown): MemoryConfig {
  const parsed = memoryConfigSchema.safeParse(raw)
  return {
    ...defaultMemoryConfig(),
    ...(parsed.success ? parsed.data : {}),
    embedding: {
      ...defaultMemoryConfig().embedding,
      ...(parsed.success ? (parsed.data.embedding ?? {}) : {}),
    },
    reranker: {
      ...defaultMemoryConfig().reranker,
      ...(parsed.success ? (parsed.data.reranker ?? {}) : {}),
    },
    chroma: {
      ...defaultMemoryConfig().chroma,
      ...(parsed.success ? (parsed.data.chroma ?? {}) : {}),
    },
    knowledgeBase: {
      ...defaultMemoryConfig().knowledgeBase,
      ...(parsed.success ? (parsed.data.knowledgeBase ?? {}) : {}),
    },
    lifecycle: {
      ...defaultMemoryConfig().lifecycle,
      ...(parsed.success ? (parsed.data.lifecycle ?? {}) : {}),
    },
  }
}

export function parseTraceConfig(raw: unknown): TraceConfig {
  const parsed = traceConfigSchema.safeParse(raw)
  return { ...defaultTraceConfig(), ...(parsed.success ? parsed.data : {}) }
}

export function parseJudgeConfig(raw: unknown): JudgeConfig {
  const parsed = judgeConfigSchema.safeParse(raw)
  return { ...defaultJudgeConfig(), ...(parsed.success ? parsed.data : {}) }
}

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string | number>
  url?: string
  headers?: Record<string, string | number>
  cwd?: string
  enabled?: boolean
  protocol?: 'auto' | 'content-length' | 'newline-json' | 'streamable-http'
}

export type RuntimeConfig = {
  model: string
  baseUrl: string
  authToken?: string
  apiKey?: string
  maxOutputTokens?: number
  mcpServers: Record<string, McpServerConfig>
  memory: MemoryConfig
  trace: TraceConfig
  judge: JudgeConfig
  sourceSummary: string
}

export type McpConfigScope = 'user' | 'project'

export const MINI_CODE_DIR = process.env.MINI_CODE_HOME
  ? path.resolve(process.env.MINI_CODE_HOME)
  : path.join(os.homedir(), '.mini-code')
export const MINI_CODE_SETTINGS_PATH = path.join(MINI_CODE_DIR, 'settings.json')
export const MINI_CODE_HISTORY_PATH = path.join(MINI_CODE_DIR, 'history.jsonl')
export const MINI_CODE_PERMISSIONS_PATH = path.join(MINI_CODE_DIR, 'permissions.json')
export const MINI_CODE_MCP_PATH = path.join(MINI_CODE_DIR, 'mcp.json')
export const MINI_CODE_MCP_TOKENS_PATH = path.join(MINI_CODE_DIR, 'mcp-tokens.json')
export const MINI_CODE_PROJECTS_DIR = path.join(MINI_CODE_DIR, 'projects')
export const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
export const PROJECT_MCP_PATH = path.join(process.cwd(), '.mcp.json')

export async function readMcpTokensFile(
  filePath = MINI_CODE_MCP_TOKENS_PATH,
): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    return parsed as Record<string, string>
  } catch (error) {
    if (isEnoentError(error)) return {}
    throw error
  }
}

export async function saveMcpTokensFile(
  tokens: Record<string, string>,
  filePath = MINI_CODE_MCP_TOKENS_PATH,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8')
}

async function readSettingsFile(filePath: string): Promise<MiniCodeSettings> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as MiniCodeSettings
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

export async function readMcpConfigFile(
  filePath: string,
): Promise<Record<string, McpServerConfig>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('mcpServers' in parsed) ||
      typeof parsed.mcpServers !== 'object' ||
      parsed.mcpServers === null
    ) {
      return {}
    }

    return parsed.mcpServers as Record<string, McpServerConfig>
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

export function getMcpConfigPath(
  scope: McpConfigScope,
  cwd = process.cwd(),
): string {
  return scope === 'project' ? path.join(cwd, '.mcp.json') : MINI_CODE_MCP_PATH
}

export async function loadScopedMcpServers(
  scope: McpConfigScope,
  cwd = process.cwd(),
): Promise<Record<string, McpServerConfig>> {
  return readMcpConfigFile(getMcpConfigPath(scope, cwd))
}

export async function saveScopedMcpServers(
  scope: McpConfigScope,
  servers: Record<string, McpServerConfig>,
  cwd = process.cwd(),
): Promise<void> {
  const targetPath = getMcpConfigPath(scope, cwd)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(
    targetPath,
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    'utf8',
  )
}

function mergeSettings(
  base: MiniCodeSettings,
  override: MiniCodeSettings,
): MiniCodeSettings {
  const mergedMcpServers = {
    ...(base.mcpServers ?? {}),
  }

  for (const [name, server] of Object.entries(override.mcpServers ?? {})) {
    mergedMcpServers[name] = {
      ...(mergedMcpServers[name] ?? {}),
      ...server,
      env: {
        ...(mergedMcpServers[name]?.env ?? {}),
        ...(server.env ?? {}),
      },
      headers: {
        ...(mergedMcpServers[name]?.headers ?? {}),
        ...(server.headers ?? {}),
      },
    }
  }

  return {
    ...base,
    ...override,
    env: {
      ...(base.env ?? {}),
      ...(override.env ?? {}),
    },
    mcpServers: mergedMcpServers,
  }
}

export async function loadEffectiveSettings(): Promise<MiniCodeSettings> {
  const [claudeSettings, globalMcpConfig, projectMcpConfig, miniCodeSettings] =
    await Promise.all([
      readSettingsFile(CLAUDE_SETTINGS_PATH),
      readMcpConfigFile(MINI_CODE_MCP_PATH),
      readMcpConfigFile(PROJECT_MCP_PATH),
      readSettingsFile(MINI_CODE_SETTINGS_PATH),
    ])
  return mergeSettings(
    mergeSettings(
      mergeSettings(claudeSettings, { mcpServers: globalMcpConfig }),
      { mcpServers: projectMcpConfig },
    ),
    miniCodeSettings,
  )
}

export async function saveMiniCodeSettings(
  updates: MiniCodeSettings,
): Promise<void> {
  await mkdir(MINI_CODE_DIR, { recursive: true })
  const existing = await readSettingsFile(MINI_CODE_SETTINGS_PATH)
  const next = mergeSettings(existing, updates)
  await writeFile(
    MINI_CODE_SETTINGS_PATH,
    `${JSON.stringify(next, null, 2)}\n`,
    'utf8',
  )
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const effectiveSettings = await loadEffectiveSettings()
  const env = {
    ...(effectiveSettings.env ?? {}),
    ...process.env,
  }

  const model =
    process.env.MINI_CODE_MODEL ||
    effectiveSettings.model ||
    String(env.ANTHROPIC_MODEL ?? '').trim()

  const baseUrl =
    String(env.ANTHROPIC_BASE_URL ?? '').trim() || 'https://api.anthropic.com'
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN ?? '').trim() || undefined
  const apiKey = String(env.ANTHROPIC_API_KEY ?? '').trim() || undefined
  const rawMaxOutputTokens =
    process.env.MINI_CODE_MAX_OUTPUT_TOKENS ??
    effectiveSettings.maxOutputTokens ??
    env.MINI_CODE_MAX_OUTPUT_TOKENS
  const parsedMaxOutputTokens =
    rawMaxOutputTokens === undefined ? NaN : Number(rawMaxOutputTokens)
  const maxOutputTokens =
    Number.isFinite(parsedMaxOutputTokens) && parsedMaxOutputTokens > 0
      ? Math.floor(parsedMaxOutputTokens)
      : undefined

  if (!model) {
    throw new Error(
      `No model configured. Set ~/.mini-code/settings.json or env.ANTHROPIC_MODEL.`,
    )
  }

  if (!authToken && !apiKey) {
    throw new Error(
      `No auth configured. Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in ~/.mini-code/settings.json or process env.`,
    )
  }

  return {
    model,
    baseUrl,
    authToken,
    apiKey,
    maxOutputTokens,
    mcpServers: effectiveSettings.mcpServers ?? {},
    memory: parseMemoryConfig(effectiveSettings.memory),
    trace: parseTraceConfig(effectiveSettings.trace),
    judge: parseJudgeConfig(effectiveSettings.judge),
    sourceSummary: `config: ${MINI_CODE_SETTINGS_PATH} > ${CLAUDE_SETTINGS_PATH} > process.env`,
  }
}
