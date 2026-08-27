/**
 * Trace event types. A trace captures one full agent turn: every phase is
 * recorded with its duration, input and output, and persisted as a single
 * JSON line in a local jsonl file.
 */

export type TraceStageName =
  | 'user_input'
  | 'rag_retrieval'
  | 'rerank'
  | 'memory_inject'
  | 'memory_extract'
  | 'llm_request'
  | 'tool_call'
  | 'tool_result'
  | 'microcompact'
  | 'auto_compact'
  | 'snip_compact'
  | 'context_collapse'
  | 'judge'
  | 'turn_total'

export type TraceStage = {
  stage: TraceStageName | string
  /** Optional per-stage label, e.g. the tool name. */
  detail?: string
  startedAt: string
  durationMs: number
  input?: unknown
  output?: unknown
  tokens?: { input?: number; output?: number }
}

export type TraceTokenStats = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  utilization?: number
}

export type Trace = {
  traceId: string
  sessionId: string
  cwd: string
  timestamp: string
  userInput: string
  model: string
  durationMs: number
  stages: TraceStage[]
  tokenStats?: TraceTokenStats
  finalOutput?: string
}

/** Compact, serializable shape of a judge run appended to the trace log. */
export type JudgeTraceEvent = {
  type: 'judge_result'
  traceId: string
  sessionId: string
  timestamp: string
  rubricId: string
  totalScore: number
  maxTotal: number
  scores: Array<{ criterionId: string; score: number; rationale: string }>
}

export type TraceLine = Trace | JudgeTraceEvent
