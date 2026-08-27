import {
  type McpConfigScope,
  type McpServerConfig,
  MINI_CODE_MCP_TOKENS_PATH,
  getMcpConfigPath,
  loadScopedMcpServers,
  readMcpTokensFile,
  saveMcpTokensFile,
  saveScopedMcpServers,
  loadEffectiveSettings,
  parseMemoryConfig,
} from './config.js'
import { discoverSkills, installSkill, removeManagedSkill } from './skills.js'
import { LongTermMemory } from './memory-ltm/index.js'
import { defaultMemoryDir } from './memory-ltm/store.js'

function printUsage(): void {
  console.log(`minicode management commands

minicode mcp list [--project]
minicode mcp add <name> [--project] [--protocol <auto|content-length|newline-json|streamable-http>] [--url <endpoint>] [--header KEY=VALUE ...] [--env KEY=VALUE ...] [-- <command> [args...]]
minicode mcp login <name> --token <bearer-token>
minicode mcp logout <name>
minicode mcp remove <name> [--project]

minicode skills list
minicode skills add <path-to-skill-or-dir> [--name <name>] [--project]
minicode skills remove <name> [--project]

minicode kb list
minicode kb scan <dir>
minicode kb import <dir> [--name <name>] [--max-chars <n>] [--overlap <n>]
minicode kb remove <name>
minicode kb clear`)
}

function parseScope(args: string[]): {
  scope: McpConfigScope
  rest: string[]
} {
  const rest = [...args]
  const projectIndex = rest.indexOf('--project')
  if (projectIndex !== -1) {
    rest.splice(projectIndex, 1)
    return { scope: 'project', rest }
  }
  return { scope: 'user', rest }
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value) {
    throw new Error(`Missing value for ${name}`)
  }
  args.splice(index, 2)
  return value
}

function takeRepeatOption(args: string[], name: string): string[] {
  const values: string[] = []
  while (true) {
    const index = args.indexOf(name)
    if (index === -1) break
    const value = args[index + 1]
    if (!value) {
      throw new Error(`Missing value for ${name}`)
    }
    values.push(value)
    args.splice(index, 2)
  }
  return values
}

function parseEnvPairs(values: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of values) {
    const separator = entry.indexOf('=')
    if (separator === -1) {
      throw new Error(`Invalid --env value: ${entry}`)
    }
    const key = entry.slice(0, separator).trim()
    const value = entry.slice(separator + 1)
    if (!key) {
      throw new Error(`Invalid --env value: ${entry}`)
    }
    env[key] = value
  }
  return env
}

async function handleMcpCommand(cwd: string, args: string[]): Promise<boolean> {
  const [subcommand, ...restArgs] = args
  if (!subcommand) {
    printUsage()
    return true
  }

  const { scope, rest } = parseScope(restArgs)

  if (subcommand === 'list') {
    const servers = await loadScopedMcpServers(scope, cwd)
    if (Object.keys(servers).length === 0) {
      console.log(`No MCP servers configured in ${getMcpConfigPath(scope, cwd)}.`)
      return true
    }

    for (const [name, server] of Object.entries(servers)) {
      const endpoint =
        server.url?.trim() ||
        `${server.command ?? ''} ${server.args?.join(' ') ?? ''}`.trim()
      const protocol = server.protocol ? ` protocol=${server.protocol}` : ''
      console.log(`${name}: ${endpoint}${protocol}`.trim())
    }
    return true
  }

  if (subcommand === 'add') {
    const separatorIndex = rest.indexOf('--')
    const head = separatorIndex === -1 ? [...rest] : rest.slice(0, separatorIndex)
    const commandParts = separatorIndex === -1 ? [] : rest.slice(separatorIndex + 1)
    const name = head.shift()
    if (!name) {
      throw new Error('Missing MCP server name.')
    }

    const protocol = takeOption(head, '--protocol') as McpServerConfig['protocol']
    const url = takeOption(head, '--url')?.trim()
    const env = parseEnvPairs(takeRepeatOption(head, '--env'))
    const headers = parseEnvPairs(takeRepeatOption(head, '--header'))
    if (head.length > 0) {
      throw new Error(`Unknown arguments: ${head.join(' ')}`)
    }

    const hasUrl = Boolean(url)
    const hasCommand = commandParts.length > 0
    if (hasUrl && hasCommand) {
      throw new Error('Cannot set both --url and local command. Choose one.')
    }
    if (!hasUrl && !hasCommand) {
      throw new Error('Missing MCP command or --url.')
    }
    if (protocol === 'streamable-http' && !hasUrl) {
      throw new Error('Protocol streamable-http requires --url.')
    }

    const [command = '', ...commandArgs] = commandParts
    const existing = await loadScopedMcpServers(scope, cwd)
    existing[name] = {
      command,
      args: hasCommand ? commandArgs : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      url: hasUrl ? url : undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      protocol,
    }
    await saveScopedMcpServers(scope, existing, cwd)
    console.log(`Added MCP server ${name} to ${getMcpConfigPath(scope, cwd)}`)
    return true
  }

  if (subcommand === 'remove') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing MCP server name.')
    }
    const existing = await loadScopedMcpServers(scope, cwd)
    if (!(name in existing)) {
      console.log(`MCP server ${name} not found in ${getMcpConfigPath(scope, cwd)}`)
      return true
    }
    delete existing[name]
    await saveScopedMcpServers(scope, existing, cwd)
    console.log(`Removed MCP server ${name} from ${getMcpConfigPath(scope, cwd)}`)
    return true
  }

  if (subcommand === 'login') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing MCP server name.')
    }
    const token = takeOption(rest, '--token')?.trim()
    if (!token) {
      throw new Error('Missing --token value.')
    }
    if (rest.length > 1) {
      throw new Error(`Unknown arguments: ${rest.slice(1).join(' ')}`)
    }
    const tokens = await readMcpTokensFile()
    tokens[name] = token
    await saveMcpTokensFile(tokens)
    console.log(`Stored MCP token for ${name} in ${MINI_CODE_MCP_TOKENS_PATH}`)
    return true
  }

  if (subcommand === 'logout') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing MCP server name.')
    }
    const tokens = await readMcpTokensFile()
    if (!(name in tokens)) {
      console.log(`No token found for ${name} in ${MINI_CODE_MCP_TOKENS_PATH}`)
      return true
    }
    delete tokens[name]
    await saveMcpTokensFile(tokens)
    console.log(`Removed MCP token for ${name} from ${MINI_CODE_MCP_TOKENS_PATH}`)
    return true
  }

  printUsage()
  return true
}

async function handleSkillsCommand(cwd: string, args: string[]): Promise<boolean> {
  const [subcommand, ...restArgs] = args
  if (!subcommand) {
    printUsage()
    return true
  }

  const { scope, rest } = parseScope(restArgs)

  if (subcommand === 'list') {
    const skills = await discoverSkills(cwd)
    if (skills.length === 0) {
      console.log('No skills discovered.')
      return true
    }
    for (const skill of skills) {
      console.log(`${skill.name}: ${skill.description} (${skill.path})`)
    }
    return true
  }

  if (subcommand === 'add') {
    const sourcePath = rest[0]
    if (!sourcePath) {
      throw new Error('Missing skill source path.')
    }
    const name = takeOption(rest, '--name')
    const result = await installSkill({
      cwd,
      sourcePath,
      name,
      scope,
    })
    console.log(`Installed skill ${result.name} at ${result.targetPath}`)
    return true
  }

  if (subcommand === 'remove') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing skill name.')
    }
    const result = await removeManagedSkill({
      cwd,
      name,
      scope,
    })
    if (!result.removed) {
      console.log(`Skill ${name} not found at ${result.targetPath}`)
      return true
    }
    console.log(`Removed skill ${name} from ${result.targetPath}`)
    return true
  }

  printUsage()
  return true
}

async function loadMemoryForKb(cwd: string): Promise<LongTermMemory> {
  const effective = await loadEffectiveSettings()
  const config = parseMemoryConfig(effective.memory)
  return LongTermMemory.create(config, { cwd, storeDir: defaultMemoryDir() })
}

async function handleKbCommand(cwd: string, args: string[]): Promise<boolean> {
  const [subcommand, ...rest] = args
  if (!subcommand) {
    printUsage()
    return true
  }

  if (subcommand === 'list') {
    const memory = await loadMemoryForKb(cwd)
    const bases = await memory.listKnowledgeBases()
    if (bases.length === 0) {
      console.log('No knowledge bases imported. Use: minicode kb import <dir>')
      return true
    }
    for (const base of bases) {
      console.log(`${base.kbName}: ${base.fileCount} files, ${base.chunkCount} chunks`)
    }
    return true
  }

  if (subcommand === 'scan') {
    const dir = rest[0]
    if (!dir) {
      throw new Error('Missing knowledge base directory: minicode kb scan <dir>')
    }
    const memory = await loadMemoryForKb(cwd)
    const files = await memory.scanKnowledgeBase(dir)
    if (files.length === 0) {
      console.log(`No supported document files found in ${dir}`)
      return true
    }
    console.log(`${files.length} files found:`)
    for (const file of files) {
      console.log(`  ${file.relPath} (${file.chars} chars)`)
    }
    return true
  }

  if (subcommand === 'import') {
    const dir = rest.shift()
    if (!dir) {
      throw new Error('Missing knowledge base directory: minicode kb import <dir>')
    }
    const name = takeOption(rest, '--name')?.trim()
    const maxChars = Number(takeOption(rest, '--max-chars') ?? '0')
    const overlap = Number(takeOption(rest, '--overlap') ?? '0')
    if (rest.length > 0) {
      throw new Error(`Unknown arguments: ${rest.join(' ')}`)
    }
    const memory = await loadMemoryForKb(cwd)
    const result = await memory.importKnowledgeBase(dir, {
      kbName: name || undefined,
      maxCharsPerChunk: maxChars > 0 ? maxChars : undefined,
      chunkOverlap: overlap > 0 ? overlap : undefined,
    })
    console.log(
      `Imported knowledge base "${name ?? dir}": ${result.fileCount} files → ${result.chunkCount} chunks (added=${result.added}, replaced=${result.replaced})`,
    )
    return true
  }

  if (subcommand === 'remove') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing knowledge base name: minicode kb remove <name>')
    }
    const memory = await loadMemoryForKb(cwd)
    const removed = await memory.removeKnowledgeBase(name)
    console.log(removed > 0
      ? `Removed knowledge base "${name}" (${removed} chunks).`
      : `Knowledge base "${name}" not found.`)
    return true
  }

  if (subcommand === 'clear') {
    const memory = await loadMemoryForKb(cwd)
    const removed = await memory.clearKnowledgeBase()
    console.log(`Cleared knowledge base store (${removed} chunks removed).`)
    return true
  }

  throw new Error(`Unknown kb subcommand: ${subcommand}`)
}

export async function maybeHandleManagementCommand(
  cwd: string,
  argv: string[],
): Promise<boolean> {
  const [category, ...rest] = argv
  if (!category) {
    return false
  }

  if (category === 'mcp') {
    return handleMcpCommand(cwd, rest)
  }

  if (category === 'skills') {
    return handleSkillsCommand(cwd, rest)
  }

  if (category === 'kb') {
    return handleKbCommand(cwd, rest)
  }

  if (category === 'help' || category === '--help' || category === '-h') {
    printUsage()
    return true
  }

  return false
}
