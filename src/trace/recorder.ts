import { appendFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isEnoentError } from '../utils/errors.js'
import { projectSlug } from '../utils/project-slug.js'
import { MINI_CODE_DIR } from '../config.js'
import type { Trace, TraceLine, TraceTokenStats, JudgeTraceEvent } from './types.js'

export type TraceRecorderOptions = {
  cwd: string
  sessionId: string
  enabled?: boolean
  dir?: string
  maxFileEntries?: number
}

/** Default trace directory: ~/.mini-code/traces/<project-slug>/. */
export function defaultTraceDir(cwd: string): string {
  return path.join(MINI_CODE_DIR, 'traces', projectSlug(cwd))
}

export function traceFilePath(cwd: string, dir?: string): string {
  return path.join(dir ?? defaultTraceDir(cwd), 'traces.jsonl')
}

/** Cap deeply nested / oversized values before writing to the trace log. */
export function safeSerialize(value: unknown, maxStringChars = 800): string {
  const seen = new WeakSet<object>()
  const visit = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) return input
    if (typeof input === 'string') {
      return input.length > maxStringChars
        ? input.slice(0, maxStringChars) + `…[+${input.length - maxStringChars} chars]`
        : input
    }
    if (typeof input !== 'object') return input
    if (depth > 6) return '[depth-limited]'
    if (seen.has(input as object)) return '[circular]'
    seen.add(input as object)
    if (Array.isArray(input)) {
      return input.slice(0, 50).map(item => visit(item, depth + 1))
    }
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      result[key] = visit(value, depth + 1)
    }
    return result
  }
  return JSON.stringify(visit(value, 0))
}

/**
 * Per-turn trace recorder. One instance is created per agent turn; stages are
 * timed via beginStage/endStage, then the whole trace is committed as a
 * single JSON line in <dir>/traces.jsonl.
 */
export class TraceRecorder {
  private current: Trace | null = null
  private readonly timers: Array<{ stage: string; detail?: string; input?: unknown; startedAt: number }> = []
  private readonly enabled: boolean
  private readonly dir: string
  private readonly maxFileEntries: number
  readonly cwd: string
  readonly sessionId: string

  constructor(options: TraceRecorderOptions) {
    this.cwd = options.cwd
    this.sessionId = options.sessionId
    this.enabled = options.enabled ?? false
    this.dir = options.dir ?? defaultTraceDir(options.cwd)
    this.maxFileEntries = options.maxFileEntries ?? 2000
  }

  get active(): boolean {
    return this.enabled
  }

  get currentTrace(): Trace | null {
    return this.current
  }

  startTurn(userInput: string, model: string): void {
    if (!this.enabled) return
    this.timers.length = 0
    this.current = {
      traceId: randomUUID().slice(0, 8),
      sessionId: this.sessionId,
      cwd: this.cwd,
      timestamp: new Date().toISOString(),
      userInput,
      model,
      durationMs: 0,
      stages: [],
    }
    this.beginStage('user_input', undefined, userInput)
    this.endStage('user_input')
  }

  beginStage(stage: string, detail?: string, input?: unknown): void {
    if (!this.enabled || !this.current) return
    this.timers.push({ stage, detail, input, startedAt: Date.now() })
  }

  endStage(stage: string, output?: unknown, tokens?: { input?: number; output?: number }): void {
    if (!this.enabled || !this.current) return
    // Match the most recent open timer for this stage name.
    let timerIndex = -1
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].stage === stage) {
        timerIndex = i
        break
      }
    }
    if (timerIndex === -1) return
    const [timer] = this.timers.splice(timerIndex, 1)
    this.current.stages.push({
      stage,
      detail: timer.detail,
      startedAt: new Date(timer.startedAt).toISOString(),
      durationMs: Date.now() - timer.startedAt,
      input: timer.input,
      output,
      tokens,
    })
  }

  /** Convenience wrapper that times an async callback as a stage. */
  async timeStage<T>(
    stage: string,
    detail: string | undefined,
    input: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.beginStage(stage, detail, input)
    try {
      const result = await fn()
      this.endStage(stage, result)
      return result
    } catch (error) {
      this.endStage(stage, error instanceof Error ? { error: error.message } : String(error))
      throw error
    }
  }

  /** Record a stage with an explicit duration (used by manual hooks). */
  markStage(stage: string, data: { detail?: string; input?: unknown; output?: unknown; durationMs?: number; tokens?: { input?: number; output?: number } }): void {
    if (!this.enabled || !this.current) return
    this.current.stages.push({
      stage,
      detail: data.detail,
      startedAt: new Date(Date.now() - (data.durationMs ?? 0)).toISOString(),
      durationMs: data.durationMs ?? 0,
      input: data.input,
      output: data.output,
      tokens: data.tokens,
    })
  }

  setTokenStats(stats: TraceTokenStats | null | undefined): void {
    if (!this.enabled || !this.current || !stats) return
    this.current.tokenStats = stats
  }

  /** Commit the finished trace as one JSON line. Returns the trace or null. */
  async commit(finalOutput?: string): Promise<Trace | null> {
    if (!this.enabled || !this.current) return null
    const trace = this.current
    trace.finalOutput = finalOutput
    trace.durationMs = Date.now() - new Date(trace.timestamp).getTime()
    this.current = null
    this.timers.length = 0
    await appendTraceLine(trace, this.dir, this.maxFileEntries)
    return trace
  }

  /** Append a judge result event referencing this session's trace id. */
  async appendJudgeEvent(event: Omit<JudgeTraceEvent, 'type' | 'sessionId' | 'timestamp'>): Promise<void> {
    if (!this.enabled) return
    const line: JudgeTraceEvent = {
      type: 'judge_result',
      traceId: event.traceId,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      rubricId: event.rubricId,
      totalScore: event.totalScore,
      maxTotal: event.maxTotal,
      scores: event.scores,
    }
    await appendTraceLine(line, this.dir, this.maxFileEntries)
  }
}

async function appendTraceLine(line: TraceLine, dir: string, maxFileEntries: number): Promise<void> {
  const file = path.join(dir, 'traces.jsonl')
  await mkdir(dir, { recursive: true })
  await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8')
  await trimTraceFile(file, maxFileEntries)
}

/**
 * Append a judge evaluation result as a trace-log event (used by /evaluate).
 * Keeps evaluation history in the same jsonl stream as turn traces.
 */
export async function appendJudgeEventToTrace(
  cwd: string,
  sessionId: string,
  event: Omit<JudgeTraceEvent, 'type' | 'sessionId' | 'timestamp'>,
  options: { dir?: string; maxFileEntries?: number } = {},
): Promise<void> {
  const line: JudgeTraceEvent = {
    type: 'judge_result',
    sessionId,
    timestamp: new Date().toISOString(),
    ...event,
  }
  await appendTraceLine(line, options.dir ?? defaultTraceDir(cwd), options.maxFileEntries ?? 2000)
}

async function trimTraceFile(file: string, maxFileEntries: number): Promise<void> {
  try {
    const info = await stat(file)
    if (info.size < 512 * 1024) return // Cheap guard: small files are fine.
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    if (lines.length <= maxFileEntries) return
    const trimmed = lines.slice(lines.length - maxFileEntries)
    await writeFile(file, `${trimmed.join('\n')}\n`, 'utf8')
  } catch {
    // Trimming is best-effort; ignore failures.
  }
}

/**
 * Read recent trace lines for a project. When sessionId is provided only
 * traces of that session are returned; otherwise the latest traces overall.
 */
export async function readRecentTraces(
  cwd: string,
  options: { dir?: string; sessionId?: string; limit?: number } = {},
): Promise<Trace[]> {
  const file = traceFilePath(cwd, options.dir)
  const limit = options.limit ?? 5
  try {
    const content = await readFile(file, 'utf8')
    const traces: Trace[] = []
    for (const line of content.split('\n').reverse()) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as TraceLine
        if (parsed && 'traceId' in parsed && !('type' in parsed)) {
          if (options.sessionId && parsed.sessionId !== options.sessionId) continue
          traces.push(parsed as Trace)
          if (traces.length >= limit) break
        }
      } catch {
        // Skip malformed lines.
      }
    }
    return traces
  } catch (error) {
    if (isEnoentError(error)) return []
    throw error
  }
}

/** Render a compact one-line summary of a trace for the /trace command. */
export function summarizeTrace(trace: Trace): string {
  const stageSummary = new Map<string, number>()
  for (const stage of trace.stages) {
    const key = stage.detail
      ? `${stage.stage}:${stage.detail}`
      : stage.stage
    stageSummary.set(key, (stageSummary.get(key) ?? 0) + stage.durationMs)
  }
  const toolCalls = trace.stages.filter(stage => stage.stage === 'tool_call').length
  const stageText = [...stageSummary.entries()]
    .map(([name, ms]) => `${name}(${ms}ms)`)
    .join(' ')
  const stats = trace.tokenStats
  const tokensText = stats
    ? ` in=${stats.inputTokens ?? '?'} out=${stats.outputTokens ?? '?'} total=${stats.totalTokens ?? '?'}`
    : ''
  return [
    `trace=${trace.traceId} session=${trace.sessionId} time=${trace.timestamp} duration=${trace.durationMs}ms`,
    `  model=${trace.model} toolCalls=${toolCalls}${tokensText}`,
    `  stages: ${stageText}`,
  ].join('\n')
}
