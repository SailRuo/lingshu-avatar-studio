import type { CharacterRecord } from '../../types/character'
import type {
  CharacterReview,
  ReviewAction,
  ReviewIssue,
  ReviewPart,
} from '../../types/analysis'
import type { ProviderConfig } from '../../types/provider'
import { blobToDataUrl } from '../imaging/blob'
import { resizeImageBlob } from '../imaging/canvas'
import { canvasToPngBlob, composeRecordCanvas, partExists } from '../imaging/compose'
import { chatOnce, stripJsonFence } from '../providers/chat'
import { REDRAW_PARTS, partLabelZh, specForRecord } from './redrawPlan'

export type ReviewStepId = 'compose' | 'vision' | 'parse' | 'plan'
export type ReviewStepStatus = 'running' | 'done' | 'failed'

export interface ReviewProgressEvent {
  step: ReviewStepId
  status: ReviewStepStatus
  detail?: string
}

export interface ReviewOptions {
  record: CharacterRecord
  provider: ProviderConfig
  apiKey: string
  model?: string
  signal?: AbortSignal
  onProgress?: (event: ReviewProgressEvent) => void
}

const REVIEW_PARTS: ReviewPart[] = ['body', 'head', 'hair', 'eyeL', 'eyeR', 'mouth']

const SYSTEM_PROMPT = `你是 2D 数字人角色的质检导演。你会看到一张已经合成好的角色图，以及这个角色当前可以重绘的部位。
只输出一个 JSON 对象，不要 Markdown、不要解释。
可用部位：body（身体与衣领）、head（头部/脸）、hair（头发）、eyeL（左眼）、eyeR（右眼）、mouth（嘴）。

请检查：
1. 是否有大面积不透明/白色/灰色矩形背景、整体背景异常；
2. 是否有图层错位、重复的五官、头发/头部被裁掉、身体接缝；
3. 发型、脸部、服装细节是否明显偏离角色设定；
4. 其他影响观看的分层问题。

输出：
{
  "score": 0-100,
  "summary": "一句话结论",
  "issues": [
    {
      "severity": "info|warn|block",
      "part": "body|head|hair|eyeL|eyeR|mouth|none",
      "message": "具体问题",
      "suggestion": "redraw|regenerate|none",
      "instruction": "局部重绘时给生图模型的具体指令；否则省略"
    }
  ],
  "recommendedAction": "redraw|regenerate|none",
  "targetPart": "body|head|hair|eyeL|eyeR|mouth",
  "repairInstruction": "如果 recommendedAction=redraw，给出具体重绘指令",
  "reason": "为什么选这个动作"
}

规则：
- 大面积白色/灰色矩形、整体背景异常、图层整体错位、重复脸/五官：recommendedAction=regenerate，不要建议局部重绘。
- 只有某个部位本身有问题、其他部分正常：recommendedAction=redraw，targetPart 指向该部位。
- 没有问题：recommendedAction=none。
- 不要假装能直接改图；你只做审查和建议，应用会按你的建议执行。
- 图中如果有明显的白色/灰色块，一定要在 issues 中指出，并建议 regenerate。`

function isPart(value: unknown): value is ReviewPart {
  return typeof value === 'string' && REVIEW_PARTS.includes(value as ReviewPart)
}

function normalizeIssue(raw: unknown): ReviewIssue | null {
  if (!raw || typeof raw !== 'object') return null
  const issue = raw as Record<string, unknown>
  const message = typeof issue.message === 'string' ? issue.message.trim() : ''
  if (!message) return null
  const severity =
    issue.severity === 'block' || issue.severity === 'warn' || issue.severity === 'info'
      ? issue.severity
      : 'warn'
  const part = issue.part === 'none' || isPart(issue.part) ? issue.part : 'none'
  const suggestion: ReviewAction =
    issue.suggestion === 'redraw' || issue.suggestion === 'regenerate' || issue.suggestion === 'none'
      ? issue.suggestion
      : 'none'
  return {
    severity,
    part,
    message,
    suggestion,
    instruction: typeof issue.instruction === 'string' ? issue.instruction.trim() : undefined,
  }
}

export function normalizeReview(raw: unknown): CharacterReview {
  if (!raw || typeof raw !== 'object') throw new Error('审查结果不是有效的 JSON 对象。')
  const value = raw as Record<string, unknown>
  const issues = Array.isArray(value.issues)
    ? value.issues.map(normalizeIssue).filter((issue): issue is ReviewIssue => Boolean(issue))
    : []
  let score = typeof value.score === 'number' ? value.score : 0
  if (score > 0 && score <= 1) score *= 100
  score = Math.max(0, Math.min(100, Math.round(score)))

  let action: ReviewAction =
    value.recommendedAction === 'redraw' ||
    value.recommendedAction === 'regenerate' ||
    value.recommendedAction === 'none'
      ? value.recommendedAction
      : 'none'
  let targetPart = isPart(value.targetPart) ? value.targetPart : undefined
  if (action === 'redraw' && !targetPart) {
    const fallback = issues.find((issue) => issue.part !== 'none' && issue.suggestion === 'redraw')
    targetPart = fallback && fallback.part !== 'none' ? fallback.part : undefined
  }
  if (action === 'redraw' && !targetPart) action = 'none'

  return {
    score,
    summary:
      typeof value.summary === 'string' && value.summary.trim()
        ? value.summary.trim()
        : '审查完成。',
    issues,
    recommendedAction: action,
    targetPart,
    repairInstruction:
      typeof value.repairInstruction === 'string' ? value.repairInstruction.trim() : undefined,
    reason: typeof value.reason === 'string' ? value.reason.trim() : undefined,
  }
}

function parseJson(text: string): unknown {
  const jsonText = stripJsonFence(text)
  const start = jsonText.indexOf('{')
  const end = jsonText.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('多模态模型没有返回 JSON 结论。')
  return JSON.parse(jsonText.slice(start, end + 1))
}

function actionLabel(review: CharacterReview): string {
  if (review.recommendedAction === 'regenerate') return '建议重新生成底图'
  if (review.recommendedAction === 'redraw' && review.targetPart) {
    return `建议重绘${partLabelZh(review.targetPart)}`
  }
  return '审查通过'
}

export async function reviewCharacter(options: ReviewOptions): Promise<CharacterReview> {
  const model = options.model || options.provider.models.chat
  if (!model) throw new Error('没有配置多模态模型的模型 ID。')
  const record = options.record
  const spec = specForRecord(record)
  const available = REDRAW_PARTS.filter((part) => partExists(record, part.id)).map(
    (part) => `${part.id}（${part.labelZh}）`,
  )

  let step: ReviewStepId = 'compose'
  try {
    options.onProgress?.({ step: 'compose', status: 'running' })
    const canvas = await composeRecordCanvas(record)
    const blob = await canvasToPngBlob(canvas)
    options.onProgress?.({
      step: 'compose',
      status: 'done',
      detail: `${canvas.width} × ${canvas.height}`,
    })

    step = 'vision'
    options.onProgress?.({ step: 'vision', status: 'running' })
    const resized = await resizeImageBlob(blob, 1024)
    const dataUrl = await blobToDataUrl(resized)
    const content = await chatOnce({
      provider: options.provider,
      apiKey: options.apiKey,
      model,
      temperature: 0.1,
      signal: options.signal,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `角色：${spec.name}`,
                spec.description ? `设定：${spec.description}` : '',
                spec.hair ? `发型：${spec.hair}` : '',
                spec.eyes ? `眼睛：${spec.eyes}` : '',
                spec.outfit ? `服装：${spec.outfit}` : '',
                `当前可重绘部位：${available.join('、') || '无'}`,
                `图层数：${Object.keys(record.manifest.layers).length}`,
                '请按 schema 输出 JSON。',
              ]
                .filter(Boolean)
                .join('\n'),
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    })
    options.onProgress?.({ step: 'vision', status: 'done', detail: model })

    step = 'parse'
    options.onProgress?.({ step: 'parse', status: 'running' })
    const parsed = parseJson(content)
    options.onProgress?.({ step: 'parse', status: 'done', detail: '已读取结构化结论' })

    step = 'plan'
    options.onProgress?.({ step: 'plan', status: 'running' })
    const review = normalizeReview(parsed)
    options.onProgress?.({
      step: 'plan',
      status: 'done',
      detail: `${actionLabel(review)} · ${review.issues.length} 个问题`,
    })
    return review
  } catch (err) {
    options.onProgress?.({
      step,
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}
