import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelAdapter } from '../src/types.js'
import { RubricJudge } from '../src/judge/index.js'
import { createDefaultRubric } from '../src/judge/rubric.js'

function fakeJudgeModel(content: string): ModelAdapter {
  return {
    async next() {
      return { type: 'assistant', content }
    },
  }
}

describe('RubricJudge', () => {
  it('scores output against the default rubric with structured rationale', async () => {
    const model = fakeJudgeModel(
      JSON.stringify({
        scores: [
          { criterionId: 'correctness', score: 4, rationale: 'The endpoint logic is correct.' },
          { criterionId: 'completeness', score: 3, rationale: 'Edge cases partially covered.' },
          { criterionId: 'tool_usage', score: 5, rationale: 'Used proper tools.' },
          { criterionId: 'clarity', score: 4, rationale: 'Clear explanation.' },
        ],
        summary: 'Solid implementation.',
      }),
    )
    const judge = new RubricJudge(model, 'test-model', 5)
    const result = await judge.evaluate({
      prompt: 'add a health endpoint',
      output: 'Added /health to server.ts',
      referenceAnswer: 'Endpoint returns 200 with status json.',
    })

    assert.equal(result.scores.length, 4)
    assert.ok(result.totalScore > 0)
    assert.ok(result.maxTotal > result.totalScore)
    assert.ok(result.weightedPercent > 0 && result.weightedPercent <= 100)
    const correctness = result.scores.find(s => s.criterionId === 'correctness')!
    assert.equal(correctness.score, 4)
    assert.equal(correctness.maxScore, 5)
    assert.match(correctness.rationale, /correct/)
    assert.equal(result.model, 'test-model')
    assert.ok(result.durationMs >= 0)
  })

  it('handles markdown-fenced JSON from the judge model', async () => {
    const model = fakeJudgeModel(
      '```json\n{"scores":[{"criterionId":"correctness","score":5,"rationale":"Perfect."}]}\n```',
    )
    const judge = new RubricJudge(model, 'm', 5)
    const result = await judge.evaluate({ prompt: 'p', output: 'o' })
    assert.equal(result.scores.length, 1)
    assert.equal(result.scores[0].score, 5)
  })

  it('retries once when the first response is invalid JSON', async () => {
    let calls = 0
    const model: ModelAdapter = {
      async next() {
        calls += 1
        if (calls === 1) {
          return { type: 'assistant', content: 'I think this looks good.' }
        }
        return {
          type: 'assistant',
          content: JSON.stringify({ scores: [{ criterionId: 'correctness', score: 4, rationale: 'ok' }] }),
        }
      },
    }
    const judge = new RubricJudge(model, 'm', 5)
    const result = await judge.evaluate({ prompt: 'p', output: 'o' })
    assert.equal(calls, 2)
    assert.equal(result.scores[0].score, 4)
  })

  it('throws when the judge keeps returning invalid JSON', async () => {
    const judge = new RubricJudge(fakeJudgeModel('not json at all'), 'm', 5)
    await assert.rejects(() => judge.evaluate({ prompt: 'p', output: 'o' }))
  })

  it('caps scores at the criterion max', async () => {
    const rubric = createDefaultRubric(5)
    const model = fakeJudgeModel(
      JSON.stringify({
        scores: [{ criterionId: 'correctness', score: 99, rationale: 'over the top' }],
      }),
    )
    const judge = new RubricJudge(model, 'm', 5)
    const result = await judge.evaluate({ prompt: 'p', output: 'o', rubric })
    assert.equal(result.scores[0].score, 5)
  })
})
