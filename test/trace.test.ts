import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ModelAdapter } from '../src/types.js'
import {
  TraceRecorder,
  readRecentTraces,
  summarizeTrace,
  appendJudgeEventToTrace,
  withTraceModel,
} from '../src/trace/index.js'

async function makeDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'minicode-trace-'))
}

describe('TraceRecorder', () => {
  let dir: string
  beforeEach(async () => {
    dir = await makeDir()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('records stages with durations and commits a single jsonl line', async () => {
    const recorder = new TraceRecorder({
      cwd: '/tmp/project',
      sessionId: 's1',
      enabled: true,
      dir,
      maxFileEntries: 100,
    })
    recorder.startTurn('add a test', 'model-x')
    recorder.beginStage('llm_request', undefined, [{ role: 'user', content: 'add a test' }])
    await new Promise(resolve => setTimeout(resolve, 5))
    recorder.endStage('llm_request', { type: 'assistant', content: 'ok' })
    recorder.beginStage('tool_call', 'write_file', { path: 'test.ts' })
    recorder.endStage('tool_call', { isError: false, output: 'written' })
    recorder.setTokenStats({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })
    const trace = await recorder.commit('Done.')

    assert.ok(trace)
    assert.equal(trace!.userInput, 'add a test')
    assert.equal(trace!.finalOutput, 'Done.')
    assert.ok(trace!.durationMs > 0)
    assert.equal(trace!.stages.length, 3)
    const llm = trace!.stages.find(s => s.stage === 'llm_request')!
    assert.ok(llm.durationMs >= 5)
    assert.equal(trace!.tokenStats?.totalTokens, 120)

    const content = await readFile(path.join(dir, 'traces.jsonl'), 'utf8')
    const lines = content.trim().split('\n')
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0])
    assert.equal(parsed.traceId, trace!.traceId)
  })

  it('does nothing when disabled', async () => {
    const recorder = new TraceRecorder({ cwd: '/tmp', sessionId: 's', enabled: false, dir })
    recorder.startTurn('x', 'm')
    const trace = await recorder.commit('y')
    assert.equal(trace, null)
  })

  it('reads recent traces back and summarizes them', async () => {
    const recorder = new TraceRecorder({ cwd: '/tmp/project', sessionId: 's1', enabled: true, dir, maxFileEntries: 100 })
    recorder.startTurn('first request', 'm1')
    recorder.beginStage('llm_request')
    recorder.endStage('llm_request', { type: 'assistant', content: 'hi' })
    await recorder.commit('first answer')

    const recorder2 = new TraceRecorder({ cwd: '/tmp/project', sessionId: 's2', enabled: true, dir, maxFileEntries: 100 })
    recorder2.startTurn('second request', 'm1')
    await recorder2.commit('second answer')

    const all = await readRecentTraces('/tmp/project', { dir, limit: 10 })
    assert.equal(all.length, 2)

    const s1 = await readRecentTraces('/tmp/project', { dir, sessionId: 's1', limit: 10 })
    assert.equal(s1.length, 1)
    assert.equal(s1[0].userInput, 'first request')

    const summary = summarizeTrace(s1[0])
    assert.match(summary, /trace=/)
    assert.match(summary, /llm_request/)
  })
})

describe('appendJudgeEventToTrace', () => {
  it('appends a judge_result line to the trace log', async () => {
    const dir = await makeDir()
    try {
      await appendJudgeEventToTrace('/tmp/project', 's1', {
        traceId: 'abc123',
        rubricId: 'default',
        totalScore: 9,
        maxTotal: 10,
        scores: [{ criterionId: 'correctness', score: 4, rationale: 'good' }],
      }, { dir })
      const content = await readFile(path.join(dir, 'traces.jsonl'), 'utf8')
      const parsed = JSON.parse(content.trim())
      assert.equal(parsed.type, 'judge_result')
      assert.equal(parsed.sessionId, 's1')
      // judge_result events must not appear as traces
      const traces = await readRecentTraces('/tmp/project', { dir })
      assert.equal(traces.length, 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('withTraceModel', () => {
  it('records every llm request as a trace stage', async () => {
    const dir = await makeDir()
    try {
      const recorder = new TraceRecorder({ cwd: '/tmp', sessionId: 's', enabled: true, dir, maxFileEntries: 100 })
      const fakeModel: ModelAdapter = {
        async next() {
          return { type: 'assistant', content: 'answer' }
        },
      }
      const traced = withTraceModel(fakeModel, recorder)
      recorder.startTurn('question', 'm')
      const step = await traced.next([{ role: 'user', content: 'question' }])
      assert.equal(step.type, 'assistant')
      const trace = await recorder.commit('answer')
      assert.ok(trace)
      const llmStage = trace!.stages.find(s => s.stage === 'llm_request')
      assert.ok(llmStage, 'llm_request stage should be recorded')
      assert.equal((llmStage!.output as { type: string }).type, 'assistant')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
