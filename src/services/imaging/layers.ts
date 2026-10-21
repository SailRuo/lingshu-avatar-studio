import type {
  CharacterTier,
  LayerId,
  Point,
  Rect,
} from '../../types/character'
import type { FaceGeometry } from '../cv/geometry'
import { clampRect, expandRect, unionRect } from '../cv/geometry'
import {
  categoriesToMask,
  createMask,
  createCanvas,
  dilateMask,
  ellipseMaskForPoints,
  foregroundFromColorKey,
  foregroundFromSegmentation,
  intersectMask,
  maskBBox,
  maskCoverage,
  maskFromPolygon,
  maskFromRect,
  subtractMask,
  unionMask,
  type Mask,
} from '../cv/masks'
import type { SegmentationResult } from '../cv/segmenter'
import { canvasToBlob, extractLayerCanvas } from './canvas'

export interface BuiltLayer {
  id: LayerId
  nameZh: string
  blob: Blob
  bbox: Rect
  pivot: Point
  z: number
  parent: 'body' | 'head'
  depth: number
  textureId: string
}

export interface LayerBuildResult {
  layers: BuiltLayer[]
  tier: CharacterTier
  notes: string[]
  geometry: FaceGeometry
  width: number
  height: number
  canvas: HTMLCanvasElement
}

function findCategory(labels: string[], candidates: string[]): number | null {
  const lowered = labels.map((label) => label.toLowerCase())
  for (const candidate of candidates) {
    const index = lowered.findIndex((label) => label.includes(candidate))
    if (index >= 0) return index
  }
  return null
}

function maskForCategory(
  segmentation: SegmentationResult | null,
  width: number,
  height: number,
  labels: string[],
): Mask | null {
  if (!segmentation) return null
  const index = findCategory(segmentation.labels, labels)
  if (index === null) return null
  const mask = categoriesToMask(segmentation, width, height, new Set([index]))
  return maskCoverage(mask, 16) > 0.001 ? mask : null
}

function buildHeadBBox(geometry: FaceGeometry, hairMask: Mask | null): Rect {
  let head = geometry.faceBBox
  if (hairMask) {
    const hairBox = maskBBox(hairMask)
    if (hairBox) head = unionRect(head, hairBox)
  }
  const expanded = expandRect(head, 0.08, 6)
  // Stop just below the chin: everything lower belongs to the body layer, and
  // keeping it in the head layer makes the shoulders swing with the head.
  const maxBottom = geometry.chinY + geometry.faceHeight * 0.08
  return clampRect(
    {
      x: expanded.x,
      y: Math.max(0, expanded.y - geometry.faceHeight * 0.04),
      w: expanded.w,
      h: Math.min(expanded.h, maxBottom - expanded.y),
    },
    geometry.width,
    geometry.height,
  )
}

function buildBodyBBox(geometry: FaceGeometry, foreground: Mask): Rect {
  const box = maskBBox(foreground)
  const fallback: Rect = {
    x: geometry.faceBBox.x - geometry.faceWidth * 0.25,
    y: geometry.chinY - geometry.faceHeight * 0.02,
    w: geometry.faceWidth * 1.5,
    h: geometry.height - (geometry.chinY - geometry.faceHeight * 0.02),
  }
  const base = box
    ? {
        x: box.x,
        y: geometry.chinY - geometry.faceHeight * 0.02,
        w: box.w,
        h: box.y + box.h - (geometry.chinY - geometry.faceHeight * 0.02),
      }
    : fallback
  return clampRect(expandRect(base, 0.03, 4), geometry.width, geometry.height)
}

function buildHairMasks(
  geometry: FaceGeometry,
  foreground: Mask,
  segmentation: SegmentationResult | null,
): { hair: Mask | null; front: Mask | null; back: Mask | null; notes: string[] } {
  const notes: string[] = []
  let hair = maskForCategory(segmentation, geometry.width, geometry.height, ['hair'])
  if (!hair) {
    const upper = maskFromRect(geometry.width, geometry.height, {
      x: 0,
      y: 0,
      w: geometry.width,
      h: Math.max(1, geometry.eyeLineY + geometry.faceHeight * 0.1),
    })
    const faceOval = maskFromPolygon(geometry.width, geometry.height, geometry.faceOval)
    hair = intersectMask(foreground, subtractMask(upper, faceOval))
    notes.push('未拿到头发分割，使用几何启发式提取发区。')
  }
  if (maskCoverage(hair, 16) < 0.004) return { hair: null, front: null, back: null, notes }

  const faceOval = maskFromPolygon(geometry.width, geometry.height, geometry.faceOval)
  const faceExpanded = dilateMask(faceOval, Math.max(4, geometry.faceWidth * 0.035))
  const frontCandidate = intersectMask(hair, faceExpanded)
  const aboveMouth = maskFromRect(geometry.width, geometry.height, {
    x: 0,
    y: 0,
    w: geometry.width,
    h: Math.max(1, geometry.mouthCenter.y - geometry.faceHeight * 0.02),
  })
  let front = intersectMask(frontCandidate, aboveMouth)
  if (maskCoverage(front, 16) < 0.0015) {
    front = intersectMask(
      hair,
      maskFromRect(geometry.width, geometry.height, {
        x: geometry.faceBBox.x,
        y: 0,
        w: geometry.faceBBox.w,
        h: Math.max(1, geometry.eyeLineY + geometry.faceHeight * 0.06),
      }),
    )
    if (maskCoverage(front, 16) > 0.001) notes.push('前发使用额头区域近似。')
  }
  let back: Mask | null = subtractMask(hair, front)
  if (!back || maskCoverage(back, 16) < 0.003) back = null
  return { hair, front: maskCoverage(front, 16) > 0.001 ? front : null, back, notes }
}

function textureIdFor(id: LayerId): string {
  return `tex_${id}`
}

export async function buildLayeredCharacter(
  source: HTMLCanvasElement,
  geometry: FaceGeometry,
  segmentation: SegmentationResult | null,
  baseNotes: string[] = [],
): Promise<LayerBuildResult> {
  const width = source.width
  const height = source.height
  const notes = [...baseNotes]

  let foreground = segmentation
    ? foregroundFromSegmentation(segmentation, width, height)
    : null
  if (!foreground || maskCoverage(foreground, 16) < 0.04 || maskCoverage(foreground, 16) > 0.97) {
    foreground = foregroundFromColorKey(source)
  }
  if (!foreground) {
    foreground = createMask(width, height, 255)
    notes.push('背景抠图失败，按整图保留；建议生成纯色背景立绘。')
  }

  const hairMasks = buildHairMasks(geometry, foreground, segmentation)
  notes.push(...hairMasks.notes)

  const faceOval = maskFromPolygon(width, height, geometry.faceOval)
  const faceExpanded = dilateMask(faceOval, Math.max(4, geometry.faceWidth * 0.035))
  const eyeLMask = intersectMask(
    ellipseMaskForPoints(width, height, geometry.eyeL, 7, 9),
    faceExpanded,
  )
  const eyeRMask = intersectMask(
    ellipseMaskForPoints(width, height, geometry.eyeR, 7, 9),
    faceExpanded,
  )
  const mouthMask = intersectMask(
    ellipseMaskForPoints(width, height, geometry.mouth, 8, 8),
    faceExpanded,
  )

  const headBox = buildHeadBBox(geometry, hairMasks.hair)
  const bodyBox = buildBodyBBox(geometry, foreground)
  const layers: BuiltLayer[] = []

  async function addLayer(
    id: LayerId,
    nameZh: string,
    mask: Mask,
    bbox: Rect,
    pivot: Point,
    z: number,
    parent: 'body' | 'head',
    depth: number,
    feather: number,
  ) {
    const box = clampRect(bbox, width, height)
    if (box.w < 8 || box.h < 8) return
    const layerCanvas = extractLayerCanvas(source, mask, box, feather)
    const blob = await canvasToBlob(layerCanvas)
    layers.push({
      id,
      nameZh,
      blob,
      bbox: box,
      pivot,
      z,
      parent,
      depth,
      textureId: textureIdFor(id),
    })
  }

  await addLayer(
    'body',
    '身体与衣领',
    foreground,
    bodyBox,
    geometry.bodyPivot,
    10,
    'body',
    0.2,
    1.2,
  )
  await addLayer(
    'head',
    '头部',
    foreground,
    headBox,
    geometry.headPivot,
    20,
    'head',
    0.6,
    1.2,
  )

  if (hairMasks.back) {
    const hairBackBox = maskBBox(hairMasks.back)
    if (hairBackBox) {
      await addLayer(
        'hairBack',
        '后发',
        hairMasks.back,
        // The head layer keeps a baked-in copy of the hair so the face and the
        // hair can be warped together when the head turns. That copy sits
        // behind this layer, so the back hair has to draw in front of the head
        // — otherwise its sway is hidden and the hair never moves.
        hairBackBox,
        geometry.headPivot,
        26,
        'head',
        0.35,
        1.8,
      )
    }
  }

  if (eyeLMask && maskCoverage(eyeLMask, 16) > 0.0002) {
    const box = maskBBox(eyeLMask)
    if (box) {
      await addLayer('eyeL', '左眼', eyeLMask, box, geometry.eyeLCenter, 27, 'head', 0.65, 1.5)
    }
  }
  if (eyeRMask && maskCoverage(eyeRMask, 16) > 0.0002) {
    const box = maskBBox(eyeRMask)
    if (box) {
      await addLayer('eyeR', '右眼', eyeRMask, box, geometry.eyeRCenter, 28, 'head', 0.65, 1.5)
    }
  }
  if (mouthMask && maskCoverage(mouthMask, 16) > 0.0002) {
    const box = maskBBox(mouthMask)
    if (box) {
      await addLayer('mouth', '嘴', mouthMask, box, geometry.mouthCenter, 29, 'head', 0.65, 1.5)
    }
  }

  if (hairMasks.front) {
    const frontBox = maskBBox(hairMasks.front)
    if (frontBox) {
      await addLayer(
        'hairFront',
        '前发',
        hairMasks.front,
        frontBox,
        { x: geometry.faceCenter.x, y: geometry.faceBBox.y + geometry.faceHeight * 0.08 },
        31,
        'head',
        1.15,
        1.8,
      )
    }
  }

  const has = (id: LayerId) => layers.some((layer) => layer.id === id)
  let tier: CharacterTier = 'portrait'
  if (has('body') && has('head')) tier = 'portrait-plus'
  if (tier === 'portrait-plus' && has('eyeL') && has('eyeR') && has('mouth')) {
    tier = 'layered-lite'
  }
  if (tier === 'layered-lite' && has('hairFront')) tier = 'full'
  if (!has('hairBack') && tier === 'full') {
    notes.push('后发未单独拆层，已合入头部/身体。')
  }
  if (!has('eyeL') || !has('eyeR')) notes.push('眼睛分层失败，眨眼将不可用。')
  if (!has('mouth')) notes.push('嘴部分层失败，口型将不可用。')

  return { layers, tier, notes, geometry, width, height, canvas: source }
}
