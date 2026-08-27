import type { McpServerConfig, RuntimeConfig } from '../config.js'
import type { McpServerSummary } from '../mcp.js'
import { createMcpBackedTools } from '../mcp.js'
import { discoverSkills } from '../skills.js'
import { ToolRegistry } from '../tool.js'
import type { LongTermMemory } from '../memory-ltm/index.js'
import { createMemoryTools } from './memory.js'
import { askUserTool } from './ask-user.js'
import { editFileTool } from './edit-file.js'
import { grepFilesTool } from './grep-files.js'
import { listFilesTool } from './list-files.js'
import { createLoadSkillTool } from './load-skill.js'
import { modifyFileTool } from './modify-file.js'
import { patchFileTool } from './patch-file.js'
import { readFileTool } from './read-file.js'
import { runCommandTool } from './run-command.js'
import { webFetchTool } from './web-fetch.js'
import { webSearchTool } from './web-search.js'
import { writeFileTool } from './write-file.js'

function summarizeServerEndpoint(config: McpServerConfig): string {
  const remoteUrl = config.url?.trim()
  if (remoteUrl) return remoteUrl
  const command = config.command?.trim() ?? ''
  const args = config.args?.join(' ') ?? ''
  return `${command} ${args}`.trim()
}

function buildConnectingMcpSummaries(
  mcpServers: Record<string, McpServerConfig>,
): McpServerSummary[] {
  return Object.entries(mcpServers).map(([name, config]) => ({
    name,
    command: summarizeServerEndpoint(config),
    status: config.enabled === false ? 'disabled' : 'connecting',
    toolCount: 0,
    protocol:
      config.protocol === 'auto' || config.protocol === undefined
        ? undefined
        : config.protocol,
  }))
}

export async function createDefaultToolRegistry(args: {
  cwd: string
  runtime: RuntimeConfig | null
  /** Optional long-term memory instance; memory tools are registered when present. */
  memory?: LongTermMemory | null
}): Promise<ToolRegistry> {
  const skills = await discoverSkills(args.cwd)
  const mcpServers = args.runtime?.mcpServers ?? {}

  // Memory tools are registered only when long-term memory is enabled,
  // keeping the default tool list identical to the original. This includes
  // knowledge_retrieve (hybrid BM25 + Chroma vector retrieval over the KB).
  const memoryTools =
    args.memory?.enabled === true
      ? createMemoryTools({ memory: args.memory })
      : []

  return new ToolRegistry([
    askUserTool,
    listFilesTool,
    grepFilesTool,
    readFileTool,
    writeFileTool,
    modifyFileTool,
    editFileTool,
    patchFileTool,
    runCommandTool,
    createLoadSkillTool(args.cwd),
    webFetchTool,
    webSearchTool,
    ...memoryTools,
  ], {
    skills,
    mcpServers: buildConnectingMcpSummaries(mcpServers),
  })
}

export async function hydrateMcpTools(args: {
  cwd: string
  runtime: RuntimeConfig | null
  tools: ToolRegistry
}): Promise<void> {
  const mcp = await createMcpBackedTools({
    cwd: args.cwd,
    mcpServers: args.runtime?.mcpServers ?? {},
  })
  args.tools.addTools(mcp.tools)
  args.tools.setMcpServers(mcp.servers)
  args.tools.addDisposer(mcp.dispose)
}
