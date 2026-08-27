import { z } from 'zod'

/**
 * Rubric evaluation: the user supplies a task prompt, an optional reference
 * answer, and one or more scoring criteria. The agent output is then handed
 * to a judge LLM which scores each criterion and explains the score.
 */

export type RubricCriterion = {
  id: string
  name: string
  description: string
  /** Relative weight, default 1. */
  weight?: number
  /** Max score for this criterion, default 5. */
  maxScore?: number
}

export type Rubric = {
  id: string
  name: string
  description?: string
  criteria: RubricCriterion[]
}

/** Zod schema that constrains the judge LLM's JSON output. */
export const judgeScoreSchema = z.object({
  criterionId: z.string().min(1),
  score: z.number().min(0),
  rationale: z.string().min(1),
})

export const judgeOutputSchema = z.object({
  scores: z.array(judgeScoreSchema).min(1),
  summary: z.string().optional(),
})

export type JudgeOutput = z.infer<typeof judgeOutputSchema>

/** Default rubric: four dimensions covering common coding-agent qualities. */
export function createDefaultRubric(maxScore = 5): Rubric {
  return {
    id: 'default',
    name: 'MiniCode 任务质量评估',
    description: '面向终端编码助手输出的通用质量评估。',
    criteria: [
      {
        id: 'correctness',
        name: '正确性',
        description: '输出是否正确解决了任务，是否存在事实错误或逻辑错误。',
        weight: 3,
        maxScore,
      },
      {
        id: 'completeness',
        name: '完整性',
        description: '是否覆盖了任务的所有要求与关键边界情况。',
        weight: 2,
        maxScore,
      },
      {
        id: 'tool_usage',
        name: '工具使用效率',
        description: '是否合理使用工具（读文件/搜索/执行命令等），避免猜测与不必要的操作。',
        weight: 1,
        maxScore,
      },
      {
        id: 'clarity',
        name: '清晰度',
        description: '表达是否清晰、结构化，结论与依据是否可理解。',
        weight: 1,
        maxScore,
      },
    ],
  }
}

export type JudgeScore = {
  criterionId: string
  criterionName: string
  score: number
  maxScore: number
  rationale: string
}

export type JudgeResult = {
  rubricId: string
  rubricName: string
  scores: JudgeScore[]
  /** Weighted raw total. */
  totalScore: number
  /** Weighted max possible total. */
  maxTotal: number
  /** Normalized percentage (0..100). */
  weightedPercent: number
  summary?: string
  model: string
  judgedAt: string
  durationMs: number
  rawResponse: string
}
