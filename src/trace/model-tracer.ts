import type { ModelAdapter } from '../types.js'
import type { TraceRecorder } from './recorder.js'

/**
 * Wrap a ModelAdapter so every LLM request during a turn is recorded as a
 * trace stage (input messages, output step, duration). The wrapper is
 * transparent to the agent loop — the core loop code is never touched.
 */
export function withTraceModel(
  model: ModelAdapter,
  recorder: TraceRecorder,
): ModelAdapter {
  return {
    async next(messages) {
      recorder.beginStage('llm_request', undefined, messages)
      const step = await model.next(messages)
      recorder.endStage('llm_request', summarizeStep(step), {
        input: step.usage?.inputTokens,
        output: step.usage?.outputTokens,
      })
      return step
    },
  }
}

/** Compact, serializable summary of an AgentStep for trace output. */
function summarizeStep(step: Awaited<ReturnType<ModelAdapter['next']>>): unknown {
  if (step.type === 'assistant') {
    return {
      type: 'assistant',
      content: step.content,
      kind: step.kind,
      diagnostics: step.diagnostics,
      usage: step.usage,
    }
  }
  return {
    type: 'tool_calls',
    content: step.content,
    contentKind: step.contentKind,
    calls: step.calls.map(call => ({
      id: call.id,
      toolName: call.toolName,
      input: call.input,
    })),
    usage: step.usage,
  }
}
