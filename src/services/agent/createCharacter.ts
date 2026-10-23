import type {
  CharacterManifest,
  CharacterRecord,
  CharacterSpec,
  CharacterTier,
  LayerId,
} from '../../types/character'
import type { VisionAnalysis } from '../../types/analysis'
import type { Persona } from '../../types/persona'
import type { ProviderConfig } from '../../types/provider'
import type { FaceGeometry } from '../cv/geometry'
import { checkFaceGeometry, computeFaceGeometry } from '../cv/geometry'
import { detectFaceLandmarks } from '../cv/landmarker'
import {
  createMask,
  foregroundFromColorKey,
  foregroundFromSegmentation,
  maskCoverage,
  type Mask,
} from '../cv/masks'
import { buildMattingForeground } from '../cv/matting/rmbg'
import { segmentImage } from '../cv/segmenter'
import { canvasFromBlobScaled, canvasToBlob, extractLayerCanvas, makeThumbnail } from '../imaging/canvas'
import { buildLayeredCharacter, type BuiltLayer, type LayerBuildResult } from '../imaging/layers'
import { aspectToSize, generateImage } from '../providers/image'
import { buildRig } from '../rig/buildRig'
import { newId } from '../id'
import { defaultPersona } from './persona'
import { buildBasePrompt } from './prompts'
import { analyzeCharacterImage } from './vision'

export interface CharacterProgressEvent {
  step: string
  label: string
  detail?: string
  progress?: number
}

export interface CreateCharacterOptions {
  spec: CharacterSpec
  imageProvider: ProviderConfig
  imageKey: string
  imageModel?: string
  agentProvider?: ProviderConfig
  agentKey?: string
  agentModel?: string
  personaOverrides?: Partial<Persona>
  seed?: number
  signal?: AbortSignal
  onProgress?: (event: CharacterProgressEvent) => void
}

export interface BuildCharacterFromImageOptions {
  image: Blob
  spec: CharacterSpec
  /** Notes to seed the manifest with, e.g. "已重绘头发". */
  baseNotes?: string[]
  id?: string
  createdAt?: number
  persona?: Persona
  personaOverrides?: Partial<Persona>
  source?: CharacterManifest['source']
  /** Absent for redraws: they must not spend another vision-model call. */
  analyze?: {
    provider: ProviderConfig
    apiKey: string
    model?: string
    signal?: AbortSignal
  }
  signal?: AbortSignal
  onProgress?: (event: CharacterProgressEvent) => void
}

export interface CreateCharacterResult {
  record: CharacterRecord
  analysis: VisionAnalysis | null
  notes: string[]
}

function fakeGeometry(width: number, height: number): FaceGeometry {
  const center = { x: width / 2, y: height * 0.42 }
  return {
    width,
    height,
    faceOval: [],
    faceBBox: { x: width * 0.2, y: height * 0.08, w: width * 0.6, h: height * 0.52 },
    eyeL: [],
    eyeR: [],
    eyeLContour: [],
    eyeRContour: [],
    eyeLCenter: { x: center.x - width * 0.07, y: center.y },
    eyeRCenter: { x: center.x + width * 0.07, y: center.y },
    mouth: [],
    mouthContour: [],
    lipInner: [],
    mouthCenter: { x: center.x, y: center.y + height * 0.12 },
    mouthUpperMid: { x: center.x, y: center.y + height * 0.1 },
    mouthLowerMid: { x: center.x, y: center.y + height * 0.14 },
    mouthCornerL: { x: center.x - width * 0.06, y: center.y + height * 0.12 },
    mouthCornerR: { x: center.x + width * 0.06, y: center.y + height * 0.12 },
    mouthInnerUpperMid: { x: center.x, y: center.y + height * 0.12 },
    mouthInnerLowerMid: { x: center.x, y: center.y + height * 0.12 },
    browL: [],
    browR: [],
    chin: { x: center.x, y: height * 0.6 },
    forehead: { x: center.x, y: height * 0.12 },
    faceCenter: center,
    headPivot: { x: center.x, y: height * 0.66 },
    bodyPivot: { x: width / 2, y: height * 0.94 },
    eyeLineY: center.y,
    chinY: height * 0.6,
    faceWidth: width * 0.6,
    faceHeight: height * 0.52,
  }
}

async function buildPortraitFallback(
  canvas: HTMLCanvasElement,
  segmentation: Awaited<ReturnType<typeof segmentImage>>,
  notes: string[],
  matting?: Mask | null,
): Promise<LayerBuildResult> {
  const width = canvas.width
  const height = canvas.height
  let foreground =
    matting ?? (segmentation ? foregroundFromSegmentation(segmentation, width, height) : null)
  const coverage = foreground ? maskCoverage(foreground, 16) : 0
  if (!foreground || coverage < 0.04 || coverage > 0.97) {
    foreground = foregroundFromColorKey(canvas)
  }
  if (!foreground) {
    foreground = createMask(width, height, 255)
    notes.push('未能抠出前景，单图模式保留完整画面。')
  }
  const box = { x: 0, y: 0, w: width, h: height }
  const layerCanvas = extractLayerCanvas(canvas, foreground, box, 0)
  const blob = await canvasToBlob(layerCanvas)
  const layer: BuiltLayer = {
    id: 'head',
    nameZh: '角色立绘',
    blob,
    bbox: box,
    pivot: { x: width / 2, y: height * 0.58 },
    z: 10,
    parent: 'head',
    depth: 1,
    textureId: 'tex_head',
  }
  return {
    layers: [layer],
    tier: 'portrait',
    notes,
    geometry: fakeGeometry(width, height),
    width,
    height,
    canvas,
  }
}

function uniqueNotes(notes: string[]): string[] {
  const seen = new Set<string>()
  return notes.filter((note) => {
    if (seen.has(note)) return false
    seen.add(note)
    return true
  })
}

function manifestNotes(
  tier: CharacterTier,
  builtNotes: string[],
  analysis: VisionAnalysis | null,
): string[] {
  const notes = [...builtNotes]
  if (analysis?.qa?.issues?.length) {
    for (const issue of analysis.qa.issues) {
      if (issue.severity === 'warn' || issue.severity === 'block') {
        notes.push(`智能体分析：${issue.message}`)
      }
    }
  }
  if (tier !== 'full') {
    notes.push(`当前能力档位为 ${tier}，部分表情/头发动作会使用近似方案。`)
  }
  return notes
}

export async function buildCharacterFromImage(
  options: BuildCharacterFromImageOptions,
): Promise<CreateCharacterResult> {
  const { spec, onProgress } = options
  const canvas = await canvasFromBlobScaled(options.image, 1536)
  onProgress?.({ step: 'cv', label: '识别脸部结构与前景', progress: 0.32 })

  const [landmarks, segmentation, analysis] = await Promise.all([
    detectFaceLandmarks(canvas),
    segmentImage(canvas),
    options.analyze
      ? analyzeCharacterImage({
          provider: options.analyze.provider,
          apiKey: options.analyze.apiKey,
          model: options.analyze.model,
          image: options.image,
          spec,
          signal: options.analyze.signal ?? options.signal,
        }).catch(() => null)
      : Promise.resolve(null),
  ])

  const notes: string[] = [...(options.baseNotes ?? [])]
  let mattingForeground: Mask | null = null
  try {
    onProgress?.({ step: 'matting', label: '抠取前景', progress: 0.45 })
    mattingForeground = await buildMattingForeground(canvas)
    if (mattingForeground) notes.push('已使用 RMBG-1.4 抠取前景。')
  } catch (err) {
    console.warn('[avatar] RMBG matting failed, falling back to segmentation', err)
    notes.push('RMBG-1.4 抠图失败，已回退到内置分割。')
  }
  onProgress?.({ step: 'layers', label: '拆分图层与自动绑定', progress: 0.55 })

  let built: LayerBuildResult
  if (landmarks) {
    const geometry = computeFaceGeometry(landmarks)
    // A detection that locks onto something that only looks like a face
    // produces a character whose head/body split and eye and mouth overlays
    // are all in the wrong place. Fall back to a flat portrait instead of
    // shipping a broken rig.
    const problems = checkFaceGeometry(geometry)
    if (problems.length) {
      for (const problem of problems) notes.push(`人脸检测不可靠：${problem.message}`)
      console.warn('[avatar] implausible face geometry', problems)
      notes.push('已降级为单图角色；换一张正面、头部完整的立绘可提升绑定效果。')
      built = await buildPortraitFallback(canvas, segmentation, notes, mattingForeground)
    } else {
      try {
        built = await buildLayeredCharacter(canvas, geometry, segmentation, notes, {
          foreground: mattingForeground ?? undefined,
          refineHairWithForeground: Boolean(mattingForeground),
        })
      } catch (err) {
        console.warn('[avatar] layered build failed, falling back to portrait', err)
        notes.push('分层失败，已降级为单图角色。')
        built = await buildPortraitFallback(canvas, segmentation, notes, mattingForeground)
      }
    }
  } else {
    notes.push('未检测到可用人脸，已生成单图角色；换一张正面、头部完整的立绘可提升绑定效果。')
    built = await buildPortraitFallback(canvas, segmentation, notes, mattingForeground)
  }

  const width = built.width
  const height = built.height
  const id = options.id ?? newId('chr')
  const now = Date.now()
  const createdAt = options.createdAt ?? now
  const rigResult = buildRig(built.layers, built.geometry, built.tier, width, height)
  onProgress?.({ step: 'thumbnail', label: '生成缩略图', progress: 0.82 })
  const thumbnail = await makeThumbnail(canvas)

  const manifest: CharacterManifest = {
    format: 'lingshu-avatar',
    formatVersion: 1,
    id,
    name: spec.name.trim() || '未命名角色',
    createdAt,
    updatedAt: now,
    tier: built.tier,
    canvas: {
      width,
      height,
      pivot: { x: width / 2, y: height * 0.94 },
    },
    layerOrder: rigResult.layerOrder,
    layers: rigResult.manifestLayers,
    textures: rigResult.textureDefs,
    expressions: [],
    capabilities: rigResult.capabilities,
    ...(options.source ? { source: options.source } : {}),
    files: {
      rig: 'rig.json',
      persona: 'persona.json',
      thumbnail: 'thumbnail.png',
    },
    notes: uniqueNotes(manifestNotes(built.tier, built.notes, analysis)),
  }

  const persona = options.persona ?? defaultPersona(spec, options.personaOverrides)
  const layers: Record<string, Blob> = {}
  for (const layer of built.layers) layers[layer.id] = layer.blob

  onProgress?.({ step: 'done', label: '角色创建完成', progress: 0.95 })
  return {
    record: {
      id,
      name: manifest.name,
      manifest,
      rig: rigResult.rig,
      persona,
      layers,
      thumbnail,
      createdAt,
      updatedAt: now,
    },
    analysis,
    notes: manifest.notes ?? [],
  }
}

export async function createCharacter(
  options: CreateCharacterOptions,
): Promise<CreateCharacterResult> {
  const { spec, imageProvider, imageKey, onProgress } = options
  const prompt = buildBasePrompt(spec)
  onProgress?.({ step: 'image', label: '生成角色立绘', detail: imageProvider.label, progress: 0.08 })
  const generated = await generateImage({
    provider: imageProvider,
    apiKey: imageKey,
    prompt,
    size: aspectToSize(spec.aspect, imageProvider),
    seed: options.seed ?? spec.seed,
    transparent: false,
    signal: options.signal,
    modelOverride: options.imageModel,
  })
  return buildCharacterFromImage({
    image: generated.blob,
    spec,
    personaOverrides: options.personaOverrides,
    source: {
      providerId: imageProvider.id,
      model: options.imageModel || imageProvider.models.image,
      prompt,
      seed: options.seed ?? spec.seed,
      variantMode: 'none',
      spec: { ...spec },
    },
    analyze:
      options.agentProvider && options.agentKey
        ? {
            provider: options.agentProvider,
            apiKey: options.agentKey,
            model: options.agentModel,
            signal: options.signal,
          }
        : undefined,
    signal: options.signal,
    onProgress,
  })
}
