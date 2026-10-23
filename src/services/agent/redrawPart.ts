import type { CharacterRecord } from '../../types/character'
import type { ProviderConfig } from '../../types/provider'
import { ProviderError } from '../providers/http'
import { editImage } from '../providers/image'
import { editSizeForProvider } from '../providers/imageSizes'
import {
  buildCharacterFromImage,
  type CharacterProgressEvent,
} from './createCharacter'
import {
  canvasToPngBlob,
  composePartMask,
  composeRecordCanvas,
  flattenOnColor,
  maskToProviderPng,
  partExists,
  scaleBlobToCanvas,
  scaleCanvas,
} from '../imaging/compose'
import {
  appendNotes,
  buildPartPrompt,
  partSpec,
  specForRecord,
  type RedrawPart,
} from './redrawPlan'

export interface RedrawPartOptions {
  record: CharacterRecord
  part: RedrawPart
  instruction?: string
  provider: ProviderConfig
  apiKey: string
  model?: string
  signal?: AbortSignal
  onProgress?: (event: CharacterProgressEvent) => void
}

export interface RedrawPartResult {
  record: CharacterRecord
  analysis: null
  notes: string[]
  part: RedrawPart
  mode: 'mask' | 'reference'
}

/** Only the OpenAI-compatible branch actually sends a mask. */
export function providerSupportsMaskEdit(provider: ProviderConfig): boolean {
  return (
    provider.supportsEdit === true &&
    provider.kind === 'openai-compatible' &&
    Boolean(provider.models.image)
  )
}

export async function redrawPart(options: RedrawPartOptions): Promise<RedrawPartResult> {
  const { record, part, provider, signal } = options
  if (!providerSupportsMaskEdit(provider)) {
    throw new ProviderError(
      'unsupported',
      '当前服务商不支持严格蒙版重绘，局部重绘已禁用，避免破坏图层。',
      { providerId: provider.id },
    )
  }
  const info = partSpec(part)
  const mode: 'mask' = 'mask'
  const spec = specForRecord(record)

  options.onProgress?.({ step: 'compose', label: '合成当前图层', progress: 0.08 })
  const composite = await composeRecordCanvas(record)
  const mask = await composePartMask(record, part)
  if (!mask) throw new Error(`当前角色没有可重绘的${info.labelZh}图层。`)
  const feather = Math.max(2, Math.round(Math.min(composite.width, composite.height) * 0.004))

  const prompt = buildPartPrompt(spec, part, options.instruction, 'mask')
  const target = editSizeForProvider(provider, composite.width, composite.height)
  const workCanvas = scaleCanvas(
    flattenOnColor(composite, '#eeeeee'),
    target.width,
    target.height,
  )
  const maskBlob = await maskToProviderPng(
    mask,
    composite.width,
    composite.height,
    feather,
    true,
  )
  const maskWork = await scaleBlobToCanvas(maskBlob, target.width, target.height)
  options.onProgress?.({ step: 'edit', label: '调用生图模型重绘', progress: 0.3 })
  const edited = await editImage({
    provider,
    apiKey: options.apiKey,
    modelOverride: options.model,
    prompt,
    size: target.size,
    image: await canvasToPngBlob(workCanvas),
    mask: await canvasToPngBlob(maskWork),
    signal,
  })
  const editedCanvas = await scaleBlobToCanvas(
    edited.blob,
    composite.width,
    composite.height,
  )

  options.onProgress?.({ step: 'rebuild', label: '重建图层与绑定', progress: 0.7 })
  const rebuilt = await buildCharacterFromImage({
    image: await canvasToPngBlob(editedCanvas),
    spec,
    persona: record.persona,
    id: record.id,
    createdAt: record.createdAt,
    baseNotes: [...(record.manifest.notes ?? []), `已重绘${info.labelZh}。`],
    source: {
      ...record.manifest.source,
      variantMode: mode === 'mask' ? 'mask-edit' : 'instruction-edit',
      spec,
    },
    signal,
    onProgress: (event) => {
      options.onProgress?.({
        ...event,
        progress: event.progress === undefined ? undefined : 0.7 + event.progress * 0.25,
      })
    },
  })
  return {
    record: rebuilt.record,
    analysis: null,
    notes: rebuilt.notes,
    part,
    mode,
  }
}

export interface RefinePartsOptions {
  record: CharacterRecord
  provider: ProviderConfig
  apiKey: string
  model?: string
  parts?: RedrawPart[]
  signal?: AbortSignal
  onProgress?: (event: CharacterProgressEvent & { part?: RedrawPart }) => void
}

export interface RefinePartsResult {
  record: CharacterRecord
  notes: string[]
  completed: RedrawPart[]
  skipped: RedrawPart[]
  failed: RedrawPart | null
}

/**
 * Rebuilds body, head and hair in that order. Hair goes last so it is painted
 * against the final face and body; a failure keeps the last successful record.
 */
export async function refineParts(options: RefinePartsOptions): Promise<RefinePartsResult> {
  const parts = options.parts ?? (['body', 'head', 'hair'] as RedrawPart[])
  if (!providerSupportsMaskEdit(options.provider)) {
    const note = '当前生图服务商不支持严格蒙版重绘，已跳过自动分部精修。'
    return {
      record: appendNotes(options.record, [note]),
      notes: [note],
      completed: [],
      skipped: parts,
      failed: null,
    }
  }

  let record = options.record
  const notes: string[] = []
  const completed: RedrawPart[] = []
  const skipped: RedrawPart[] = []
  let failed: RedrawPart | null = null

  for (const part of parts) {
    if (options.signal?.aborted) break
    const info = partSpec(part)
    if (!partExists(record, part)) {
      skipped.push(part)
      notes.push(`跳过${info.labelZh}：当前角色没有独立图层。`)
      continue
    }
    try {
      const result = await redrawPart({
        record,
        part,
        provider: options.provider,
        apiKey: options.apiKey,
        model: options.model,
        signal: options.signal,
        onProgress: (event) => {
          const label = event.label.startsWith(info.labelZh)
            ? event.label
            : `${info.labelZh} · ${event.label}`
          options.onProgress?.({ ...event, label, part })
        },
      })
      record = result.record
      completed.push(part)
      options.onProgress?.({
        step: part,
        label: `${info.labelZh}精修完成`,
        progress: 0.95,
        part,
      })
    } catch (err) {
      if (options.signal?.aborted) break
      failed = part
      notes.push(`${info.labelZh}精修失败：${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  return { record: appendNotes(record, notes), notes, completed, skipped, failed }
}
