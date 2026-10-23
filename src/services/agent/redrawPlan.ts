import type { CharacterRecord, CharacterSpec, LayerId } from '../../types/character'

export type RedrawPart = 'body' | 'head' | 'hair' | 'eyeL' | 'eyeR' | 'mouth'

export interface PartLayerRef {
  id: LayerId
  /** Layers drawn in front of this one; their pixels are not part of the edit region. */
  subtract?: LayerId[]
}

export interface PartSpec {
  id: RedrawPart
  labelZh: string
  labelEn: string
  layers: PartLayerRef[]
  promptField?: 'outfit' | 'eyes' | 'hair'
  /** What the reference-edit prompt must tell the model to leave out. */
  referenceExclusions: string
}

export const REDRAW_PARTS: PartSpec[] = [
  {
    id: 'body',
    labelZh: '身体与衣领',
    labelEn: 'body and outfit',
    layers: [{ id: 'body', subtract: ['head', 'hairFront', 'hairBack'] }],
    promptField: 'outfit',
    referenceExclusions: 'the head, hair, face, hands, props and background',
  },
  {
    id: 'head',
    labelZh: '头部',
    labelEn: 'face and head',
    layers: [{ id: 'head', subtract: ['hairFront', 'hairBack'] }],
    promptField: 'eyes',
    referenceExclusions: 'the body, clothing, hair, neck and background',
  },
  {
    id: 'hair',
    labelZh: '头发',
    labelEn: 'hair',
    // Both hair layers draw in front of the head (the head's baked copy sits
    // behind them), so their alpha union is the visible hair region. The back
    // hair is still behind the eyes and mouth, so those stay out of its mask.
    layers: [
      { id: 'hairFront' },
      { id: 'hairBack', subtract: ['eyeL', 'eyeR', 'mouth'] },
    ],
    promptField: 'hair',
    referenceExclusions: 'the face, eyes, neck, body, clothing and background',
  },
  {
    id: 'eyeL',
    labelZh: '左眼',
    labelEn: 'left eye',
    layers: [{ id: 'eyeL', subtract: ['hairFront'] }],
    referenceExclusions: 'the rest of the face, hair, body and background',
  },
  {
    id: 'eyeR',
    labelZh: '右眼',
    labelEn: 'right eye',
    layers: [{ id: 'eyeR', subtract: ['hairFront'] }],
    referenceExclusions: 'the rest of the face, hair, body and background',
  },
  {
    id: 'mouth',
    labelZh: '嘴',
    labelEn: 'mouth',
    layers: [{ id: 'mouth', subtract: ['hairFront'] }],
    referenceExclusions: 'the rest of the face, hair, body and background',
  },
]

export function partSpec(id: RedrawPart): PartSpec {
  const spec = REDRAW_PARTS.find((part) => part.id === id)
  if (!spec) throw new Error(`未知的重绘部位：${id}`)
  return spec
}

export function partLabelZh(id: RedrawPart): string {
  return partSpec(id).labelZh
}

export function defaultPartInstruction(spec: CharacterSpec, part: RedrawPart): string {
  const info = partSpec(part)
  if (info.promptField === 'hair') {
    return spec.hair ? `Hair: ${spec.hair}.` : 'Keep the same hairstyle but improve strand detail.'
  }
  if (info.promptField === 'eyes') {
    return spec.eyes ? `Eyes: ${spec.eyes}. Keep the same face and identity.` : 'Keep the same face and identity.'
  }
  if (info.promptField === 'outfit') {
    return spec.outfit
      ? `Outfit: ${spec.outfit}. Keep the same body pose.`
      : 'Keep the same outfit but improve fabric detail.'
  }
  return `Keep the same ${info.labelEn} shape and color; improve detail only.`
}

export function buildPartPrompt(
  spec: CharacterSpec,
  part: RedrawPart,
  instruction?: string,
  mode: 'mask' | 'reference' = 'mask',
): string {
  const info = partSpec(part)
  const detail = instruction?.trim() || defaultPartInstruction(spec, part)
  const palette = spec.palette ? ` Palette: ${spec.palette}.` : ''

  if (mode === 'reference') {
    return [
      'This is a layered 2D avatar asset for a digital character studio.',
      `The attached image is the current ${info.labelEn} layer of this character, isolated on a plain background.`,
      `Redraw only the ${info.labelEn} and output it as a complete, isolated ${info.labelEn} asset.`,
      `Do not include ${info.referenceExclusions}.`,
      'Use a plain, uniform background around the part.',
      detail,
      'Keep the same character identity, color palette, line style and lighting as the reference.',
      `The result will be used as the ${info.labelEn} layer in a 2D avatar, so keep it centered, complete and unobstructed.`,
    ]
      .filter(Boolean)
      .join(' ')
  }

  return [
    'This is a layered 2D avatar edit. Same character, same framing, pose, camera angle, lighting, art style and facial identity.',
    `Only regenerate the ${info.labelEn} inside the masked area.`,
    detail,
    `${palette}`.trim(),
    'Keep every pixel outside the masked area unchanged.',
    'Do not change the background, body proportions, or any other part of the character.',
  ]
    .filter(Boolean)
    .join(' ')
}

export function specForRecord(record: CharacterRecord): CharacterSpec {
  const saved = record.manifest.source?.spec
  if (saved) return saved
  const ratio = record.manifest.canvas.width / Math.max(1, record.manifest.canvas.height)
  return {
    name: record.name,
    description: record.persona.background || record.persona.occupation || '',
    style: '',
    hair: '',
    eyes: '',
    outfit: '',
    palette: '',
    aspect: ratio < 0.74 ? '2:3' : ratio < 0.95 ? '3:4' : '1:1',
  }
}

export function appendNotes(record: CharacterRecord, notes: string[]): CharacterRecord {
  if (!notes.length) return record
  const existing = record.manifest.notes ?? []
  const merged = [...existing]
  for (const note of notes) {
    if (!merged.includes(note)) merged.push(note)
  }
  const now = Date.now()
  return {
    ...record,
    updatedAt: now,
    manifest: { ...record.manifest, notes: merged, updatedAt: now },
  }
}
