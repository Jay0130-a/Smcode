import type { ChatMessage } from '../types.js'
import type { MemoryKind, MemoryMetadata, MemoryScope } from './types.js'
import { truncateText } from './tokenize.js'

export type ExtractedMemory = {
  scope: MemoryScope
  kind: MemoryKind
  content: string
  metadata: MemoryMetadata
}

const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'patch_file', 'modify_file'])
const MAX_TASK_CHARS = 800
const MAX_RESULT_CHARS = 800
const MAX_LESSON_CHARS = 500

function extractPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const value = (input as Record<string, unknown>).path
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Extract concise long-term memories from a finished agent turn:
 *  1. task memory — the user request and the final outcome
 *  2. file-change memory — files written/edited during the turn
 *  3. lesson memory — failed tool calls worth remembering
 * Scope follows the configured default scope (session by default).
 */
export function extractMemoriesFromTurn(args: {
  messages: ChatMessage[]
  cwd: string
  sessionId?: string
  defaultScope?: MemoryScope
}): ExtractedMemory[] {
  const { messages, cwd, sessionId, defaultScope = 'session' } = args
  const scope = defaultScope
  const memories: ExtractedMemory[] = []

  const userMessages = messages.filter((m): m is Extract<ChatMessage, { role: 'user' }> => m.role === 'user')
  const assistantMessages = messages.filter((m): m is Extract<ChatMessage, { role: 'assistant' }> => m.role === 'assistant')
  const toolCalls = messages.filter((m): m is Extract<ChatMessage, { role: 'assistant_tool_call' }> => m.role === 'assistant_tool_call')
  const toolResults = messages.filter((m): m is Extract<ChatMessage, { role: 'tool_result' }> => m.role === 'tool_result')

  const firstUser = userMessages[0]
  const lastAssistant = assistantMessages.at(-1)

  if (firstUser) {
    const taskText = truncateText(firstUser.content, MAX_TASK_CHARS)
    const resultText = lastAssistant
      ? truncateText(lastAssistant.content, MAX_RESULT_CHARS)
      : ''
    const content = resultText
      ? `[TASK] ${taskText}\n[RESULT] ${resultText}`
      : `[TASK] ${taskText}`
    memories.push({
      scope,
      kind: 'extracted',
      content,
      metadata: { cwd, sessionId, sourceRole: 'user' },
    })
  }

  const editedFiles: string[] = []
  const editToolNames: string[] = []
  for (const call of toolCalls) {
    if (EDIT_TOOLS.has(call.toolName)) {
      const filePath = extractPath(call.input)
      if (filePath && !editedFiles.includes(filePath)) {
        editedFiles.push(filePath)
        editToolNames.push(call.toolName)
      }
    }
  }
  if (editedFiles.length > 0) {
    memories.push({
      scope,
      kind: 'extracted',
      content: `[FILE CHANGES] 本次会话修改了以下文件:\n${editedFiles.map(file => `- ${file}`).join('\n')}`,
      metadata: { cwd, sessionId, filePaths: editedFiles, toolNames: [...new Set(editToolNames)] },
    })
  }

  const errors = toolResults.filter(result => result.isError)
  if (errors.length > 0) {
    const lesson = errors
      .slice(-3)
      .map(error => `工具 ${error.toolName} 执行失败: ${truncateText(error.content, MAX_LESSON_CHARS)}`)
      .join('\n')
    memories.push({
      scope: 'global',
      kind: 'extracted',
      content: `[LESSON] ${lesson}`,
      metadata: { cwd, sessionId, toolNames: errors.map(error => error.toolName) },
    })
  }

  return memories
}
