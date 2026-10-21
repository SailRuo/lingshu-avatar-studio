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
import { computeFaceGeometry } from '../cv/geometry'
import { detectFaceLandmarks } from '../cv/landmarker'
import {
  createMask,
  foregroundFromColorKey,
  foregroundFromSegmentation,
  maskCoverage,
} from '../cv/masks'
import { segmentImage } from '../cv/segmenter'
import { canvasFromBlobScaled, canvasToBlob, extractLayerCanvas, makeThumbnail } from '../imaging/canvas'
import { buildLayeredCharacter, type BuiltLayer, type LayerBuildResult } from '../imaging/layers'
import { aspectToSize, generateImage } from '../providers/image'
import { buildRig } from '../rig/buildRig'
import { newId } from '../id'
import { defaultPersona } from './persona'
import { buildBasePrompt } from './prompts'
import { analyzeCharacterImage } from './vision'

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
  onProgress?: (event: {
    step: string
    label: string
    detail?: string
    progress?: number
  }) => void
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
    eyeLCenter: { x: center.x - width * 0.07, y: center.y },
    eyeRCenter: { x: center.x + width * 0.07, y: center.y },
    mouth: [],
    mouthCenter: { x: center.x, y: center.y + height * 0.12 },
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
): Promise<LayerBuildResult> {
  const width = canvas.width
  const height = canvas.height
  let foreground = segmentation ? foregroundFromSegmentation(segmentation, width, height) : null
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
  const canvas = await canvasFromBlobScaled(generated.blob, 1536)
  onProgress?.({ step: 'cv', label: '识别脸部结构与前景', progress: 0.32 })

  const [landmarks, segmentation, analysis] = await Promise.all([
    detectFaceLandmarks(canvas),
    segmentImage(canvas),
    options.agentProvider && options.agentKey
      ? analyzeCharacterImage({
          provider: options.agentProvider,
          apiKey: options.agentKey,
          model: options.agentModel,
          image: generated.blob,
          spec,
          signal: options.signal,
        }).catch(() => null)
      : Promise.resolve(null),
  ])
  onProgress?.({ step: 'layers', label: '拆分图层与自动绑定', progress: 0.55 })

  const notes: string[] = []
  let built: LayerBuildResult
  if (landmarks) {
    try {
      const geometry = computeFaceGeometry(landmarks)
      built = await buildLayeredCharacter(canvas, geometry, segmentation, notes)
    } catch (err) {
      console.warn('[avatar] layered build failed, falling back to portrait', err)
      notes.push('分层失败，已降级为单图角色。')
      built = await buildPortraitFallback(canvas, segmentation, notes)
    }
  } else {
    notes.push('未检测到可用人脸，已生成单图角色；换一张正面、头部完整的立绘可提升绑定效果。')
    built = await buildPortraitFallback(canvas, segmentation, notes)
  }

  const width = built.width
  const height = built.height
  const id = newId('chr')
  const now = Date.now()
  const rigResult = buildRig(built.layers, built.geometry, built.tier, width, height)
  onProgress?.({ step: 'thumbnail', label: '生成缩略图', progress: 0.82 })
  const thumbnail = await makeThumbnail(canvas)

  const manifest: CharacterManifest = {
    format: 'lingshu-avatar',
    formatVersion: 1,
    id,
    name: spec.name.trim() || '未命名角色',
    createdAt: now,
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
    source: {
      providerId: imageProvider.id,
      model: options.imageModel || imageProvider.models.image,
      prompt,
      seed: options.seed ?? spec.seed,
      variantMode: 'none',
    },
    files: {
      rig: 'rig.json',
      persona: 'persona.json',
      thumbnail: 'thumbnail.png',
    },
    notes: manifestNotes(built.tier, built.notes, analysis),
  }

  const persona = defaultPersona(spec, options.personaOverrides)
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
      createdAt: now,
      updatedAt: now,
    },
    analysis,
    notes: manifest.notes ?? [],
  }
}
