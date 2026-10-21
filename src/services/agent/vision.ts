import type { CharacterSpec } from '../../types/character'
import type { VisionAnalysis } from '../../types/analysis'
import type { ProviderConfig } from '../../types/provider'
import { blobToDataUrl } from '../imaging/blob'
import { resizeImageBlob } from '../imaging/canvas'
import { chatOnce, stripJsonFence } from '../providers/chat'
import { buildBasePrompt, summarizeSpecForVision } from './prompts'

const SYSTEM_PROMPT = `你是 2D 角色技术导演。你看一张角色立绘，只输出一个 JSON 对象，不要 Markdown、不要解释。
不要估计精确像素坐标；bbox 用 0..1 归一化。你需要判断：
- character: apparentAge(teen|young-adult|mature), genderPresentation(feminine|masculine|androgynous), style(anime-cel|soft-anime|semi-realistic|chibi), palette(string[])
- framing: bust(head|bust|half), facing(front|three-quarter), yawDeg(number), centered(boolean), headFullyVisible(boolean), symmetry(0..1)
- parts: 数组，每项 {id, bbox:{x,y,w,h}, confidence, notes?}；id 从 hair/face/eyes/brows/mouth/neck/body/ears/accessories 选
- layerPlan: 数组，每项 {id, nameZh, z, parent(root|body|head), motion, strategy(parse|derived|generated|patch), needsInpaint, notes?}
- expressionPlan: 数组，每项 {id(blink|mouthOpen|smile), mode(image-edit|mesh-warp|skip), editInstruction, priority}
- rigHints: {headPivotHint?, shoulderLineY?, hairlineY?, chinY?, eyeLineY?}
- qa: {issues:[{code,severity(info|warn|block),message}], overallScore(0..1), proceed(boolean)}
只根据图片可见内容判断。如果朝向不是正面、头部被裁切、有多张脸或眼睛被遮挡，把 qa.proceed 设为 false 并在 issues 说明。`

function normalize(parsed: unknown): VisionAnalysis | null {
  if (!parsed || typeof parsed !== 'object') return null
  const raw = parsed as Partial<VisionAnalysis>
  const defaults: VisionAnalysis = {
    version: 1,
    character: {
      apparentAge: 'young-adult',
      genderPresentation: 'androgynous',
      style: 'soft-anime',
      palette: [],
    },
    framing: {
      bust: 'bust',
      facing: 'front',
      yawDeg: 0,
      centered: true,
      headFullyVisible: true,
      symmetry: 0.8,
    },
    parts: [],
    layerPlan: [],
    expressionPlan: [],
    rigHints: {},
    qa: { issues: [], overallScore: 0.7, proceed: true },
  }
  const merged: VisionAnalysis = {
    ...defaults,
    ...raw,
    character: { ...defaults.character, ...(raw.character ?? {}) },
    framing: { ...defaults.framing, ...(raw.framing ?? {}) },
    parts: Array.isArray(raw.parts) ? raw.parts : [],
    layerPlan: Array.isArray(raw.layerPlan) ? raw.layerPlan : [],
    expressionPlan: Array.isArray(raw.expressionPlan) ? raw.expressionPlan : [],
    rigHints: raw.rigHints ?? {},
    qa: { ...defaults.qa, ...(raw.qa ?? {}) },
  }
  if (typeof merged.qa.overallScore !== 'number') merged.qa.overallScore = 0.7
  if (typeof merged.qa.proceed !== 'boolean') merged.qa.proceed = true
  if (!Array.isArray(merged.qa.issues)) merged.qa.issues = []
  return merged
}

export async function analyzeCharacterImage(options: {
  provider: ProviderConfig
  apiKey: string
  model?: string
  image: Blob
  spec: CharacterSpec
  signal?: AbortSignal
}): Promise<VisionAnalysis | null> {
  const model = options.model || options.provider.models.chat
  if (!model) return null
  const resized = await resizeImageBlob(options.image, 1024)
  const dataUrl = await blobToDataUrl(resized)
  try {
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
              text: `角色设定：\n${summarizeSpecForVision(options.spec)}\n\n生图 prompt：\n${buildBasePrompt(options.spec)}\n\n请按 schema 输出 JSON。`,
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    })
    const jsonText = stripJsonFence(content)
    const start = jsonText.indexOf('{')
    const end = jsonText.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    return normalize(JSON.parse(jsonText.slice(start, end + 1)))
  } catch (err) {
    console.warn('[avatar] vision analysis failed', err)
    return null
  }
}
