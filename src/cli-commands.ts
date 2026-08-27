import {
  CLAUDE_SETTINGS_PATH,
  MINI_CODE_MCP_PATH,
  MINI_CODE_PERMISSIONS_PATH,
  MINI_CODE_SETTINGS_PATH,
  loadRuntimeConfig,
  saveMiniCodeSettings,
} from './config.js'
import path from 'node:path'
import { initializeRepo, renderInitReport } from './init.js'
import { discoverInstructionFiles, renderMemoryReport } from './memory.js'
import { readRecentTraces, summarizeTrace } from './trace/index.js'
import type { ToolRegistry } from './tool.js'

export type SlashCommand = {
  name: string
  usage: string
  description: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/help',
    usage: '/help',
    description: 'Show available slash commands.',
  },
  {
    name: '/tools',
    usage: '/tools',
    description: 'List tools available to the coding agent and tool shortcuts.',
  },
  {
    name: '/status',
    usage: '/status',
    description: 'Show current model and config source.',
  },
  {
    name: '/model',
    usage: '/model',
    description: 'Show the current model.',
  },
  {
    name: '/model',
    usage: '/model <model-name>',
    description: 'Persist a model override into ~/.mini-code/settings.json.',
  },
  {
    name: '/config-paths',
    usage: '/config-paths',
    description: 'Show mini-code and Claude fallback settings paths.',
  },
  {
    name: '/skills',
    usage: '/skills',
    description: 'List discovered SKILL.md workflows.',
  },
  {
    name: '/mcp',
    usage: '/mcp',
    description: 'Show configured MCP servers and connection state.',
  },
  {
    name: '/resume',
    usage: '/resume',
    description: 'Resume a saved session (interactive picker, or /resume <id>).',
  },
  {
    name: '/rename',
    usage: '/rename <name>',
    description: 'Rename the current session.',
  },
  {
    name: '/new',
    usage: '/new',
    description: 'Clear saved session and start fresh.',
  },
  {
    name: '/fork',
    usage: '/fork',
    description: 'Fork current session into a new independent session.',
  },
  {
    name: '/permissions',
    usage: '/permissions',
    description: 'Show mini-code permission storage path.',
  },
  {
    name: '/exit',
    usage: '/exit',
    description: 'Exit mini-code.',
  },
  {
    name: '/ls',
    usage: '/ls [path]',
    description: 'List files in a directory.',
  },
  {
    name: '/grep',
    usage: '/grep <pattern>::[path]',
    description: 'Search text in files.',
  },
  {
    name: '/read',
    usage: '/read <path>',
    description: 'Read a file directly.',
  },
  {
    name: '/write',
    usage: '/write <path>::<content>',
    description: 'Write a file directly.',
  },
  {
    name: '/modify',
    usage: '/modify <path>::<content>',
    description: 'Replace a file, showing a reviewable diff before applying it.',
  },
  {
    name: '/edit',
    usage: '/edit <path>::<search>::<replace>',
    description: 'Edit a file by exact replacement.',
  },
  {
    name: '/patch',
    usage: '/patch <path>::<search1>::<replace1>::<search2>::<replace2>...',
    description: 'Apply multiple replacements to one file in one command.',
  },
  {
    name: '/cmd',
    usage: '/cmd [cwd::]<command> [args...]',
    description: 'Run an allowed development command directly, optionally in another directory.',
  },
  {
    name: '/compact',
    usage: '/compact',
    description: 'Compress conversation context to free up context window space.',
  },
  {
    name: '/collapse',
    usage: '/collapse',
    description: 'Project old safe context spans into summaries without deleting the transcript.',
  },
  {
    name: '/snip',
    usage: '/snip',
    description: 'Remove a safe middle segment of conversation context without calling the model.',
  },
  {
    name: '/init',
    usage: '/init',
    description: 'Create .mini-code/, .gitignore entries, and MINI.md in the current project (idempotent).',
  },
  {
    name: '/memory',
    usage: '/memory',
    description: 'Show instruction files loaded into the system prompt.',
  },
  {
    name: '/trace',
    usage: '/trace [n]',
    description: 'Show trace summaries of recent turns (default 5) for the current session.',
  },
  {
    name: '/index',
    usage: '/index',
    description: 'Manually (re)build the external business-document RAG knowledge base index. Requires memory.knowledgeBase.path in settings.json.',
  },
  {
    name: '/memory-ltm',
    usage: '/memory-ltm <list|rm <id>>',
    description: 'Manage long-term memory (list / delete by id). Requires memory.enabled.',
  },
]

export function formatSlashCommands(): string {
  return SLASH_COMMANDS.map(command => `${command.usage}  ${command.description}`).join('\n')
}

export function findMatchingSlashCommands(input: string): string[] {
  return SLASH_COMMANDS
    .map(command => command.usage)
    .filter(command => command.startsWith(input))
}

function formatPermissionSummary(permissionSummary: string[] = []): string {
  const findValue = (label: string): string => {
    const raw = permissionSummary.find(part => part.startsWith(`${label}: `))
    return raw?.slice(label.length + 2).trim() || 'none'
  }

  return [
    `permission store: ${MINI_CODE_PERMISSIONS_PATH}`,
    `cwd: ${findValue('cwd')}`,
    `extra allowed dirs: ${findValue('extra allowed dirs')}`,
    `dangerous allowlist: ${findValue('dangerous allowlist')}`,
  ].join('\n')
}

export async function tryHandleLocalCommand(
  input: string,
  context?: {
    cwd?: string
    tools?: ToolRegistry
    permissionSummary?: string[]
    /** Current session id, used to scope /trace output. */
    sessionId?: string
    /** Optional long-term memory instance for /memory-ltm. */
    memory?: import('./memory-ltm/index.js').LongTermMemory | null
    /** knowledgeBasePath from settings; enables the business-doc RAG KB. */
    knowledgeBasePath?: string
  },
): Promise<string | null> {
  const cwd = context?.cwd ?? process.cwd()

  if (input === '/') {
    return formatSlashCommands()
  }

  if (input === '/help') {
    return formatSlashCommands()
  }

  if (input === '/config-paths') {
    return [
      `mini-code settings: ${MINI_CODE_SETTINGS_PATH}`,
      `mini-code permissions: ${MINI_CODE_PERMISSIONS_PATH}`,
      `mini-code mcp: ${MINI_CODE_MCP_PATH}`,
      `compat fallback: ${CLAUDE_SETTINGS_PATH}`,
    ].join('\n')
  }

  if (input === '/permissions') {
    return formatPermissionSummary(context?.permissionSummary)
  }

  if (input === '/skills') {
    const skills = context?.tools?.getSkills() ?? []
    if (skills.length === 0) {
      return 'No skills discovered. Add skills under ~/.mini-code/skills/<name>/SKILL.md, .mini-code/skills/<name>/SKILL.md, .claude/skills/<name>/SKILL.md, or ~/.claude/skills/<name>/SKILL.md.'
    }

    return skills
      .map(
        skill =>
          `${skill.name}  ${skill.description}  [${skill.source}]`,
      )
      .join('\n')
  }

  if (input === '/mcp') {
    const servers = context?.tools?.getMcpServers() ?? []
    if (servers.length === 0) {
      return 'No MCP servers configured. Add mcpServers to ~/.mini-code/settings.json, ~/.mini-code/mcp.json, or project .mcp.json.'
    }

    return servers
      .map(server => {
        const suffix = server.error ? `  error=${server.error}` : ''
        const protocol = server.protocol ? `  protocol=${server.protocol}` : ''
        const resources =
          server.resourceCount !== undefined
            ? `  resources=${server.resourceCount}`
            : ''
        const prompts =
          server.promptCount !== undefined
            ? `  prompts=${server.promptCount}`
            : ''
        return `${server.name}  status=${server.status}  tools=${server.toolCount}${resources}${prompts}${protocol}${suffix}`
      })
      .join('\n')
  }

  if (input === '/status') {
    const runtime = await loadRuntimeConfig()
    return [
      `model: ${runtime.model}`,
      `baseUrl: ${runtime.baseUrl}`,
      `auth: ${runtime.authToken ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'}`,
      `mcp servers: ${Object.keys(runtime.mcpServers).length}`,
      runtime.sourceSummary,
    ].join('\n')
  }

  if (input === '/init') {
    const report = await initializeRepo(cwd)
    return renderInitReport(report)
  }

  if (input === '/memory') {
    const files = await discoverInstructionFiles(cwd)
    return renderMemoryReport(files, cwd)
  }

  if (input === '/trace' || input.startsWith('/trace ')) {
    const nArg = input === '/trace' ? undefined : input.slice('/trace '.length).trim()
    const limit = nArg && Number(nArg) > 0 ? Math.min(Number(nArg), 50) : 5
    const traces = await readRecentTraces(cwd, {
      sessionId: context?.sessionId,
      limit,
    })
    if (traces.length === 0) {
      return 'No traces recorded yet. Enable "trace.enabled": true in ~/.mini-code/settings.json, then run a turn.'
    }
    return traces.map(summarizeTrace).join('\n\n')
  }

  if (input === '/index') {
    const memory = context?.memory ?? null
    const kbPath = context?.knowledgeBasePath?.trim()
    if (!kbPath) {
      return 'Knowledge base is not enabled. Set "memory.knowledgeBase.path" (knowledgeBasePath) in ~/.mini-code/settings.json, then run /index.'
    }
    if (!memory) {
      return 'Knowledge base store is unavailable (memory module failed to initialize).'
    }
    try {
      const startedAt = Date.now()
      const kbName = path.basename(path.resolve(kbPath))
      const result = await memory.importKnowledgeBase(kbPath, {
        kbName,
        maxCharsPerChunk: memory.config.knowledgeBase?.maxCharsPerChunk,
        chunkOverlap: memory.config.knowledgeBase?.chunkOverlap,
      })
      const durationMs = Date.now() - startedAt
      return (
        `Knowledge base indexed in ${durationMs}ms: ${result.fileCount} files → ${result.chunkCount} chunks (added=${result.added}, replaced=${result.replaced}).\n` +
        `vector backend: ${memory.vectorBackend}; embedding: ${memory.embeddingProviderName || 'none (BM25-only retrieval)'}.`
      )
    } catch (error) {
      return `Knowledge base indexing failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (input === '/memory-ltm' || input.startsWith('/memory-ltm ')) {
    const memory = context?.memory ?? null
    if (!memory?.enabled) {
      return 'Long-term memory is not enabled. Set "memory.enabled": true in ~/.mini-code/settings.json.'
    }
    const args = input === '/memory-ltm' ? '' : input.slice('/memory-ltm '.length).trim()

    // Knowledge-base management subcommands.
    if (args === 'kb' || args.startsWith('kb ')) {
      const sub = args === 'kb' ? '' : args.slice(3).trim()
      if (!sub || sub === 'list') {
        const bases = await memory.listKnowledgeBases()
        if (bases.length === 0) {
          return 'No knowledge bases imported. Use: /memory-ltm kb import <dir> [name]'
        }
        return (
          'Knowledge bases:\n' +
          bases.map(base => `- ${base.kbName}: ${base.fileCount} files, ${base.chunkCount} chunks`).join('\n')
        )
      }
      if (sub.startsWith('scan ')) {
        const dir = sub.slice(5).trim()
        const files = await memory.scanKnowledgeBase(dir)
        if (files.length === 0) {
          return `No supported document files found in ${dir}`
        }
        return `${files.length} files found:\n` + files.map(file => `- ${file.relPath} (${file.chars} chars)`).join('\n')
      }
      if (sub.startsWith('import ')) {
        const rest = sub.slice(7).trim()
        const parts = rest.split(' ')
        const dir = parts.shift()
        const name = parts.length > 0 ? parts.join(' ') : undefined
        if (!dir) {
          return 'Usage: /memory-ltm kb import <dir> [name]'
        }
        const result = await memory.importKnowledgeBase(dir, { kbName: name })
        return `Imported "${name ?? dir}": ${result.fileCount} files → ${result.chunkCount} chunks (added=${result.added}, replaced=${result.replaced}).`
      }
      if (sub.startsWith('remove ')) {
        const name = sub.slice(7).trim()
        const removed = await memory.removeKnowledgeBase(name)
        return removed > 0
          ? `Removed knowledge base "${name}" (${removed} chunks).`
          : `Knowledge base "${name}" not found.`
      }
      if (sub === 'clear') {
        const removed = await memory.clearKnowledgeBase()
        return `Cleared knowledge base store (${removed} chunks removed).`
      }
      return 'Usage: /memory-ltm kb <list|scan <dir>|import <dir> [name]|remove <name>|clear>'
    }

    // Lifecycle maintenance subcommand.
    if (args === 'gc') {
      const result = await memory.gc()
      return `GC complete: demoted=${result.demoted}, archived=${result.archived}, expired=${result.expired}, evicted=${result.evicted}.`
    }

    if (!args || args === 'list') {
      const entries = await memory.list({ scopes: ['session', 'global'], limit: 50 })
      const count = await memory.count()
      if (entries.length === 0) {
        return `No memories stored (session=${count.session}, global=${count.global}).`
      }
      return (
        `Long-term memories (session=${count.session}, global=${count.global}):\n` +
        entries
          .map(entry => `[${entry.scope}/${entry.stage}] ${entry.id} (${entry.createdAt})\n${entry.content}`)
          .join('\n\n')
      )
    }
    if (args.startsWith('rm ')) {
      const id = args.slice(3).trim()
      const ok = await memory.forget(id)
      return ok ? `Memory ${id} deleted.` : `Memory ${id} not found.`
    }
    return 'Usage: /memory-ltm list | /memory-ltm rm <id>'
  }

  if (input === '/model') {
    const runtime = await loadRuntimeConfig()
    return `current model: ${runtime.model}`
  }

  if (input.startsWith('/model ')) {
    const model = input.slice('/model '.length).trim()
    if (!model) {
      return '用法: /model <model-name>'
    }

    await saveMiniCodeSettings({ model })
    return `saved model=${model} to ${MINI_CODE_SETTINGS_PATH}`
  }

  return null
}

export function completeSlashCommand(line: string): [string[], string] {
  const hits = SLASH_COMMANDS
    .map(command => command.usage)
    .filter(command => command.startsWith(line))

  return [hits.length > 0 ? hits : SLASH_COMMANDS.map(command => command.usage), line]
}
