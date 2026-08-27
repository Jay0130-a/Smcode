import crypto from 'node:crypto'
import path from 'node:path'
import readline from 'node:readline'
import process from 'node:process'
import { AnthropicModelAdapter } from './anthropic-adapter.js'
import {
  completeSlashCommand,
  findMatchingSlashCommands,
  tryHandleLocalCommand,
} from './cli-commands.js'
import { loadRuntimeConfig } from './config.js'
import { forkSession } from './session.js'
import { maybeHandleManagementCommand } from './manage-cli.js'
import { summarizeMcpServers } from './mcp-status.js'
import { MockModelAdapter } from './mock-model.js'
import { PermissionManager } from './permissions.js'
import { buildSystemPrompt } from './prompt.js'
import { createDefaultToolRegistry, hydrateMcpTools } from './tools/index.js'
import { LongTermMemory } from './memory-ltm/index.js'
import { TraceRecorder, withTraceModel } from './trace/index.js'
import type { ChatMessage } from './types.js'
import { renderBanner } from './ui.js'
import { runTtyApp } from './tty-app.js'
import { runAgentTurn } from './agent-loop.js'
import {
  applyContextCollapseIfNeeded,
  createContextCollapseState,
} from './compact/context-collapse.js'
import { createContentReplacementState } from './utils/tool-result-storage.js'

async function main(): Promise<void> {
  const cwd = process.cwd()
  const argv = process.argv.slice(2)

  let memory: LongTermMemory | null = null
  let traceRecorder: TraceRecorder | null = null

  let resumeTarget: string | 'picker' | undefined
  const resumeIndex = argv.indexOf('--resume')
  if (resumeIndex !== -1) {
    argv.splice(resumeIndex, 1)
    const nextArg = argv[resumeIndex]
    if (nextArg && !nextArg.startsWith('-')) {
      resumeTarget = nextArg
      argv.splice(resumeIndex, 1)
    } else {
      resumeTarget = 'picker'
    }
  }

  let forkTarget: string | undefined
  const forkIndex = argv.indexOf('--fork')
  if (forkIndex !== -1) {
    argv.splice(forkIndex, 1)
    const nextArg = argv[forkIndex]
    if (nextArg && !nextArg.startsWith('-')) {
      forkTarget = nextArg
      argv.splice(forkIndex, 1)
    }
  }

  if (await maybeHandleManagementCommand(cwd, argv)) {
    return
  }

  const isInteractiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  let runtime = null
  try {
    runtime = await loadRuntimeConfig()
  } catch {
    runtime = null
  }
  if (runtime) {
    memory = await LongTermMemory.create(runtime.memory, { cwd })
    traceRecorder = new TraceRecorder({
      cwd,
      sessionId: 'cli',
      enabled: runtime.trace.enabled === true,
      maxFileEntries: runtime.trace.maxFileEntries,
    })
  }

  // Auto-import configured business-document knowledge bases at startup.
  // Enabled when memory.knowledgeBase.path (knowledgeBasePath) is configured.
  const kbConfig = runtime?.memory.knowledgeBase
  const kbDirs = [...(kbConfig?.dirs ?? []), ...(kbConfig?.path?.trim() ? [kbConfig.path.trim()] : [])]
  if (memory && kbDirs.length > 0) {
    for (const dir of kbDirs) {
      try {
        await memory.importKnowledgeBase(dir, {
          kbName: path.basename(path.resolve(dir)),
          maxCharsPerChunk: kbConfig?.maxCharsPerChunk,
          chunkOverlap: kbConfig?.chunkOverlap,
        })
      } catch {
        // A failing knowledge base must not block startup.
      }
    }
  }

  // Lifecycle garbage collection at startup (when enabled in config).
  if (memory?.enabled && runtime?.memory.lifecycle?.gcOnStartup !== false) {
    try {
      await memory.gc()
    } catch {
      // GC is best-effort; never block startup on it.
    }
  }

  const tools = await createDefaultToolRegistry({
    cwd,
    runtime,
    memory,
  })
  const mcpHydration = hydrateMcpTools({
    cwd,
    runtime,
    tools,
  }).catch(() => {
    // Keep startup resilient even if some MCP servers fail.
  })
  const permissions = new PermissionManager(cwd)
  await permissions.whenReady()
  const model =
    process.env.MINI_CODE_MODEL_MODE === 'mock'
      ? new MockModelAdapter()
      : new AnthropicModelAdapter(tools, loadRuntimeConfig)
  let messages: ChatMessage[] = [
    {
      role: 'system',
      content: await buildSystemPrompt(cwd, permissions.getSummary(), {
        skills: tools.getSkills(),
        mcpServers: tools.getMcpServers(),
      }),
    },
  ]
  const contentReplacementState = createContentReplacementState()
  const contextCollapseState = createContextCollapseState()

  async function refreshSystemPrompt(): Promise<void> {
    messages[0] = {
      role: 'system',
      content: await buildSystemPrompt(cwd, permissions.getSummary(), {
        skills: tools.getSkills(),
        mcpServers: tools.getMcpServers(),
      }),
    }
  }

  try {
    if (isInteractiveTerminal) {
      let sessionId = crypto.randomUUID().slice(0, 8)
      let resolvedResumeTarget = resumeTarget

      if (forkTarget) {
        const forkedId = await forkSession(cwd, forkTarget)
        if (forkedId) {
          sessionId = forkedId
          resolvedResumeTarget = forkedId
        } else {
          console.error(`Session ${forkTarget} not found or empty.`)
        }
      }

      await runTtyApp({
        runtime,
        tools,
        model,
        messages,
        cwd,
        permissions,
        contentReplacementState,
        contextCollapseState,
        sessionId,
        alreadySavedCount: 0,
        resumeTarget: resolvedResumeTarget,
        memory,
      })
      return
    }

    const mcpStatus = summarizeMcpServers(tools.getMcpServers())
    console.log(
      renderBanner(runtime, cwd, permissions.getSummary(), {
        transcriptCount: 0,
        messageCount: messages.length,
        skillCount: tools.getSkills().length,
        mcpTotalCount: mcpStatus.total,
        mcpConnectedCount: mcpStatus.connected,
        mcpConnectingCount: mcpStatus.connecting,
        mcpErrorCount: mcpStatus.error,
      }),
    )
    console.log('')

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: completeSlashCommand,
    })

    for await (const rawInput of rl) {
      const input = rawInput.trim()
      if (!input) {
        continue
      }
      if (input === '/exit') break

      try {
        if (input === '/tools') {
          console.log(
            `\n${tools.list().map(tool => `${tool.name}: ${tool.description}`).join('\n')}\n`,
          )
          continue
        }

        if (input === '/collapse') {
          if (!runtime?.model) {
            console.log('\nNo model configured. Cannot collapse context.\n')
            continue
          }

          const result = await applyContextCollapseIfNeeded(
            messages,
            runtime.model,
            model,
            contextCollapseState,
            {
              utilizationThreshold: 0,
              reason: 'manual',
            },
          )
          contextCollapseState.spans = [...result.state.spans]
          contextCollapseState.enabled = result.state.enabled
          contextCollapseState.consecutiveFailures = result.state.consecutiveFailures

          if (!result.collapsed) {
            console.log(
              result.state.enabled
                ? '\nNothing safe to collapse.\n'
                : '\nContext collapse is disabled after repeated summary failures.\n',
            )
            continue
          }

          const savedTokens = result.spans.reduce(
            (sum, span) => sum + Math.max(0, span.tokensBefore - span.tokensAfter),
            0,
          )
          console.log(
            `\nContext collapse projected ${result.spans.length} span${result.spans.length === 1 ? '' : 's'} into model-visible summaries, saving ~${Math.round(savedTokens)} tokens. Original transcript is preserved.\n`,
          )
          continue
        }

        const localCommandResult = await tryHandleLocalCommand(input, {
          cwd,
          tools,
          permissionSummary: permissions.getSummary(),
          sessionId: 'cli',
          memory,
          knowledgeBasePath: runtime?.memory.knowledgeBase?.path?.trim() || undefined,
        })
        if (localCommandResult !== null) {
          console.log(`\n${localCommandResult}\n`)
          continue
        }

        if (input.startsWith('/')) {
          const matches = findMatchingSlashCommands(input)
          if (matches.length > 0) {
            console.log(`\n未识别命令。你是不是想输入：\n${matches.join('\n')}\n`)
          } else {
            console.log(`\n未识别命令。输入 /help 查看可用命令。\n`)
          }
          continue
        }
      } catch (error) {
        console.log(
          `\n${error instanceof Error ? error.message : String(error)}\n`,
        )
        continue
      }

      await refreshSystemPrompt()
      traceRecorder?.startTurn(input, runtime?.model ?? '')

      // Wire memory/embedding/chroma degradations into this turn's trace.
      memory?.setErrorReporter(message => {
        traceRecorder?.markStage('memory_error', {
          detail: 'degraded',
          input: message.slice(0, 300),
          output: { degraded: true },
        })
      })

      // Long-term memory: hybrid retrieval and injection before the user message.
      if (memory?.enabled) {
        const marker = LongTermMemory.injectionMarker()
        messages = messages.filter(message => !(message.role === 'system' && message.content.startsWith(marker)))
        const { hits } = await memory.search(input, { topK: memory.config.topK })
        if (hits.length > 0) {
          messages = [...messages, { role: 'system', content: memory.renderHits(hits) }]
        }
      }

      messages = [...messages, { role: 'user', content: input }]
      permissions.beginTurn()
      try {
        const tracedModel = traceRecorder?.active
          ? withTraceModel(model, traceRecorder)
          : model
        messages = await runAgentTurn({
          model: tracedModel,
          tools,
          messages,
          cwd,
          permissions,
          modelName: runtime?.model ?? '',
          contentReplacementState,
          contextCollapseState,
        })
        if (memory?.enabled) {
          await memory.extractFromTurn({ messages, sessionId: 'cli' })
        }
        const lastAssistant = [...messages]
          .reverse()
          .find(message => message.role === 'assistant')
        await traceRecorder?.commit(
          lastAssistant?.role === 'assistant' ? lastAssistant.content : undefined,
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: `请求失败: ${message}`,
          },
        ]
        await traceRecorder?.commit()
      } finally {
        permissions.endTurn()
      }

      const lastAssistant = [...messages]
        .reverse()
        .find(message => message.role === 'assistant')

      if (lastAssistant?.role === 'assistant') {
        console.log(`\n${lastAssistant.content}\n`)
      }
    }

    try {
      rl.close()
    } catch {
      // Ignore double-close during EOF teardown.
    }
  } finally {
    await mcpHydration
    await tools.dispose()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
