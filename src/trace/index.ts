export {
  TraceRecorder,
  readRecentTraces,
  summarizeTrace,
  defaultTraceDir,
  traceFilePath,
  safeSerialize,
  appendJudgeEventToTrace,
} from './recorder.js'
export type { TraceRecorderOptions } from './recorder.js'
export { withTraceModel } from './model-tracer.js'
export type {
  Trace,
  TraceStage,
  TraceLine,
  TraceStageName,
  TraceTokenStats,
  JudgeTraceEvent,
} from './types.js'
