import type { ModelAdapter, ChatMessage } from '../types.js'
import {
  judgeOutputSchema,
  createDefaultRubric,
  type JudgeResult,
  type JudgeScore,
  type Rubric,
} from './rubric.js'

export type JudgeEvaluateArgs = {
  /** The original user task prompt. */
  prompt: string
  /** The agent output being evaluated. */
  output: string
  /** Optional reference answer (ground truth). */
  referenceAnswer?: string
  /** Optional rubric; defaults to the built-in rubric. */
  rubric?: Rubric
  /** Optional extra evidence, e.g. tool call summaries from the trace. */
  context?: string
}

const MAX_INPUT_CHARS = 12_000

function buildSystemPrompt(maxScore: number): string {
  return [
    'You are an impartial LLM judge evaluating a coding assistant output against a rubric.',
    'Score EVERY criterion in the rubric on a 0 to ' + String(maxScore) + ' scale using whole numbers or one decimal.',
    'Be strict and evidence-based. A score of 0 means the criterion is entirely unmet; ' + String(maxScore) + ' means fully met.',
    'For each criterion provide a concise rationale (2-3 sentences) referencing the output.',
    'Respond with ONLY a single JSON object, no markdown fences, no commentary:',
    '{"scores":[{"criterionId":"<id>","score":<number>,"rationale":"<text>"}],"summary":"<optional overall summary>"}',
  ].join('\n')
}

function buildUserPrompt(args: {
  rubric: Rubric
  maxScore: number
  prompt: string
  output: string
  referenceAnswer?: string
  context?: string
}): string {
  const { rubric, prompt, output, referenceAnswer, context } = args
  const criteriaText = rubric.criteria
    .map(
      (criterion, index) =>
        `${index + 1}. ${criterion.name} (id=${criterion.id}, weight=${criterion.weight ?? 1}, max=${criterion.maxScore ?? args.maxScore})\n   ${criterion.description}`,
    )
    .join('\n')

  const parts = [
    `# Rubric: ${rubric.name}${rubric.description ? `\n${rubric.description}` : ''}`,
    '# Criteria',
    criteriaText,
    '# Task Prompt',
    prompt.slice(0, MAX_INPUT_CHARS),
  ]

  if (referenceAnswer && referenceAnswer.trim()) {
    parts.push('# Reference Answer\n' + referenceAnswer.slice(0, MAX_INPUT_CHARS))
  }
  if (context && context.trim()) {
    parts.push('# Evidence (tool activity)\n' + context.slice(0, MAX_INPUT_CHARS))
  }

  parts.push('# Agent Output to Evaluate\n' + output.slice(0, MAX_INPUT_CHARS))
  return parts.join('\n\n')
}

/** Strip markdown code fences if the judge model wrapped the JSON anyway. */
function extractJson(text: string): string {
  const trimmed = text.trim()
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) return fenceMatch[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1)
  }
  return trimmed
}

/**
 * LLM-as-Judge rubric scorer. Reuses the existing ModelAdapter (e.g.
 * AnthropicModelAdapter with an empty tool registry) so no LLM request
 * implementation is duplicated. Judge output is validated with Zod.
 */
export class RubricJudge {
  constructor(
    private readonly model: ModelAdapter,
    private readonly modelName: string,
    private readonly maxScore = 5,
  ) {}

  async evaluate(args: JudgeEvaluateArgs): Promise<JudgeResult> {
    const rubric = args.rubric ?? createDefaultRubric(this.maxScore)
    const maxScore = this.maxScore
    const startedAt = Date.now()

    const userPrompt = buildUserPrompt({
      rubric,
      maxScore,
      prompt: args.prompt,
      output: args.output,
      referenceAnswer: args.referenceAnswer,
      context: args.context,
    })

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(maxScore) },
      { role: 'user', content: userPrompt },
    ]

    let raw = ''
    let parsed: ReturnType<typeof judgeOutputSchema.safeParse> | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const step = await this.model.next(messages)
      raw = step.type === 'assistant' ? step.content : (step.content ?? '')
      try {
        parsed = judgeOutputSchema.safeParse(JSON.parse(extractJson(raw)))
      } catch {
        parsed = null
      }
      if (parsed?.success) break
      if (attempt === 0) {
        messages.push(
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content: 'Your previous response was not valid JSON matching the required schema. Return ONLY the JSON object now.',
          },
        )
      }
    }

    if (!parsed || !parsed.success) {
      throw new Error(
        `Judge model returned invalid JSON: ${raw.slice(0, 300)}`,
      )
    }

    const output = parsed.data
    const criterionById = new Map(rubric.criteria.map(c => [c.id, c]))
    const scores: JudgeScore[] = output.scores.map(score => {
      const criterion = criterionById.get(score.criterionId)
      return {
        criterionId: score.criterionId,
        criterionName: criterion?.name ?? score.criterionId,
        score: Math.min(score.score, criterion?.maxScore ?? maxScore),
        maxScore: criterion?.maxScore ?? maxScore,
        rationale: score.rationale,
      }
    })

    let totalScore = 0
    let maxTotal = 0
    for (const score of scores) {
      const weight = criterionById.get(score.criterionId)?.weight ?? 1
      totalScore += score.score * weight
      maxTotal += score.maxScore * weight
    }

    return {
      rubricId: rubric.id,
      rubricName: rubric.name,
      scores,
      totalScore,
      maxTotal,
      weightedPercent: maxTotal === 0 ? 0 : Math.round((totalScore / maxTotal) * 1000) / 10,
      summary: output.summary,
      model: this.modelName,
      judgedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      rawResponse: raw,
    }
  }
}

export {
  judgeOutputSchema,
  judgeScoreSchema,
  createDefaultRubric,
} from './rubric.js'
export type {
  Rubric,
  RubricCriterion,
  JudgeOutput,
  JudgeScore,
  JudgeResult,
} from './rubric.js'
