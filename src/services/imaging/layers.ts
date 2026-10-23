import type {
  CharacterTier,
  LayerId,
  Point,
  Rect,
} from '../../types/character'
import type { FaceGeometry } from '../cv/geometry'
import { clampRect, expandRect, unionRect } from '../cv/geometry'
import {
  createMask,
  createCanvas,
  dilateMask,
  ellipseMaskForPoints,
  foregroundFromColorKey,
  intersectMask,
  isDegeneratePolygon,
  maskBBox,
  maskCoverage,
  maskFromEllipse,
  maskFromPolygon,
  maskFromRect,
  removeSmallComponents,
  resizeMaskNearest,
  subtractMask,
  unionMask,
  type Mask,
} from '../cv/masks'
import type { SegmentationResult } from '../cv/segmenter'
import { upsampleMaskGuided } from '../cv/upsample'
import {
  createMouthCavityCanvas,
  isUsableInnerLip,
  MOUTH_APERTURE_HEIGHT,
  MOUTH_APERTURE_WIDTH,
  punchMouthAperture,
  softenMouthCorners,
} from './mouthCavity'
import { controlFromGeometry } from '../render/mouthDeform'
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

function readSourceImage(source: HTMLCanvasElement): ImageData | null {
  try {
    const ctx = source.getContext('2d', { willReadFrequently: true })
    return ctx ? ctx.getImageData(0, 0, source.width, source.height) : null
  } catch (err) {
    console.warn('[avatar] cannot read source pixels for guided mask upsampling', err)
    return null
  }
}

function nativeCategoryMask(
  segmentation: SegmentationResult,
  include: (category: number) => boolean,
): Mask {
  const mask = createMask(segmentation.width, segmentation.height)
  for (let i = 0; i < mask.data.length; i += 1) {
    if (include(segmentation.categories[i])) mask.data[i] = 255
  }
  return mask
}

function upsampleCategoryMask(
  mask: Mask,
  guide: ImageData | null,
  width: number,
  height: number,
): Mask {
  if (guide && guide.width === width && guide.height === height) {
    try {
      return upsampleMaskGuided(mask, guide)
    } catch (err) {
      console.warn('[avatar] guided mask upsampling failed, falling back to nearest', err)
    }
  }
  return resizeMaskNearest(mask, width, height)
}

function maskForCategory(
  segmentation: SegmentationResult | null,
  width: number,
  height: number,
  labels: string[],
  guide: ImageData | null,
): Mask | null {
  if (!segmentation) return null
  const index = findCategory(segmentation.labels, labels)
  if (index === null) return null
  const low = nativeCategoryMask(segmentation, (category) => category === index)
  const mask = upsampleCategoryMask(low, guide, width, height)
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

function ringPoints(contour: Point[], fallback: Point[]): Point[] {
  return contour.length >= 3 ? contour : fallback
}

function buildHairMasks(
  geometry: FaceGeometry,
  foreground: Mask,
  segmentation: SegmentationResult | null,
  guide: ImageData | null,
  refineWithForeground = false,
): { hair: Mask | null; front: Mask | null; back: Mask | null; notes: string[] } {
  const notes: string[] = []
  let hair = maskForCategory(segmentation, geometry.width, geometry.height, ['hair'], guide)
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
  if (refineWithForeground) {
    // A matting model gives the best silhouette we have. Clipping the hair
    // category mask to it removes the halo the 256px segmenter leaves around
    // the head, and the soft alpha keeps strand edges soft.
    hair = intersectMask(hair, foreground)
  }
  if (maskCoverage(hair, 16) < 0.004) return { hair: null, front: null, back: null, notes }

  const faceOval = maskFromPolygon(geometry.width, geometry.height, geometry.faceOval)
  const faceExpanded = dilateMask(faceOval, Math.max(4, geometry.faceWidth * 0.035))
  const frontCandidate = intersectMask(hair, faceExpanded)

  // Eyes and lips sit inside the dilated face oval, so without a guard band the
  // front-hair mask would cut them out of the head layer.
  const featureGuard = dilateMask(
    unionMask(
      unionMask(
        maskFromPolygon(
          geometry.width,
          geometry.height,
          ringPoints(geometry.eyeLContour, geometry.eyeL),
        ),
        maskFromPolygon(
          geometry.width,
          geometry.height,
          ringPoints(geometry.eyeRContour, geometry.eyeR),
        ),
      ),
      maskFromPolygon(
        geometry.width,
        geometry.height,
        ringPoints(geometry.mouthContour, geometry.mouth),
      ),
    ),
    Math.max(2, geometry.faceWidth * 0.012),
  )

  // Long sideburns are legitimately front hair, so the cap sits just below the
  // chin; anything further down is neck/chest and must stay in the body layer.
  const frontRegion = maskFromRect(geometry.width, geometry.height, {
    x: 0,
    y: 0,
    w: geometry.width,
    h: Math.max(1, geometry.chinY + geometry.faceHeight * 0.1),
  })

  let front = intersectMask(subtractMask(frontCandidate, featureGuard), frontRegion)
  if (maskCoverage(front, 16) < 0.0015) {
    front = intersectMask(
      subtractMask(
        intersectMask(
          hair,
          maskFromRect(geometry.width, geometry.height, {
            x: geometry.faceBBox.x,
            y: 0,
            w: geometry.faceBBox.w,
            h: Math.max(1, geometry.eyeLineY + geometry.faceHeight * 0.06),
          }),
        ),
        featureGuard,
      ),
      frontRegion,
    )
    if (maskCoverage(front, 16) > 0.001) notes.push('前发使用额头区域近似。')
  }

  // Both masks come from upsampled segmentation, so isolated specks are
  // segmentation noise rather than real hair strands.
  const minArea = Math.max(16, Math.round(geometry.width * geometry.height * 0.00001))
  front = removeSmallComponents(front, minArea)
  let back: Mask | null = removeSmallComponents(subtractMask(hair, front), minArea)
  if (!back || maskCoverage(back, 16) < 0.003) back = null
  return { hair, front: maskCoverage(front, 16) > 0.001 ? front : null, back, notes }
}

function textureIdFor(id: LayerId): string {
  return `tex_${id}`
}

function buildFeatureMask(
  geometry: FaceGeometry,
  width: number,
  height: number,
  contour: Point[],
  fallback: Point[],
  padX: number,
  padY: number,
  faceExpanded: Mask,
  label: string,
  notes: string[],
): Mask {
  // A too-small landmark polygon usually means a bad detection frame, so the
  // ellipse is the safer cut than a sliver of a mask.
  const minArea = Math.max(8, geometry.faceWidth * geometry.faceHeight * 0.00005)
  if (isDegeneratePolygon(contour, minArea)) {
    notes.push(`${label}轮廓不可用，改用椭圆近似。`)
    return intersectMask(ellipseMaskForPoints(width, height, fallback, padX, padY), faceExpanded)
  }
  // Eyelashes and the lip line sit just outside the landmark ring; a small
  // dilation keeps them attached to the moving layer.
  const pad = Math.max(1.5, geometry.faceWidth * 0.008)
  return intersectMask(dilateMask(maskFromPolygon(width, height, contour), pad), faceExpanded)
}

export interface LayerBuildOptions {
  /** Soft foreground alpha from an optional matting model (RMBG-1.4). */
  foreground?: Mask
  /** Clip the hair category mask to the matting foreground. */
  refineHairWithForeground?: boolean
  /**
   * A picture of the same character with the mouth slightly open, aligned to
   * the source canvas. When present the mouth cavity is cut from its real
   * pixels instead of being painted.
   */
  mouthReference?: HTMLCanvasElement
}

/**
 * How far the opening of the mouth reaches beyond the inner lip line.
 *
 * The line between the lips has to disappear completely, otherwise the parts
 * of it that survive at the corners get stretched into a strange wave when
 * the jaw drops.
 */
const APERTURE_GROW = 0.8

export async function buildLayeredCharacter(
  source: HTMLCanvasElement,
  geometry: FaceGeometry,
  segmentation: SegmentationResult | null,
  baseNotes: string[] = [],
  options: LayerBuildOptions = {},
): Promise<LayerBuildResult> {
  const width = source.width
  const height = source.height
  const notes = [...baseNotes]

  // Read the guide pixels once and share them between the foreground and hair
  // masks; reading a 1536px canvas twice is measurable.
  const guide = readSourceImage(source)
  if (!guide) notes.push('无法读取原图像素，分割边缘使用最近邻放大。')

  let foreground: Mask | null =
    options.foreground ??
    (segmentation
      ? upsampleCategoryMask(
          nativeCategoryMask(segmentation, (category) => category > 0),
          guide,
          width,
          height,
        )
      : null)
  if (!foreground || maskCoverage(foreground, 16) < 0.04 || maskCoverage(foreground, 16) > 0.97) {
    foreground = foregroundFromColorKey(source)
  }
  if (!foreground) {
    foreground = createMask(width, height, 255)
    notes.push('背景抠图失败，按整图保留；建议生成纯色背景立绘。')
  }

  const hairMasks = buildHairMasks(
    geometry,
    foreground,
    segmentation,
    guide,
    options.refineHairWithForeground ?? false,
  )
  notes.push(...hairMasks.notes)

  const faceOval = maskFromPolygon(width, height, geometry.faceOval)
  const faceExpanded = dilateMask(faceOval, Math.max(4, geometry.faceWidth * 0.035))
  const featureNotes: string[] = []
  const eyeLMask = buildFeatureMask(
    geometry,
    width,
    height,
    geometry.eyeLContour,
    geometry.eyeL,
    7,
    9,
    faceExpanded,
    '左眼',
    featureNotes,
  )
  const eyeRMask = buildFeatureMask(
    geometry,
    width,
    height,
    geometry.eyeRContour,
    geometry.eyeR,
    7,
    9,
    faceExpanded,
    '右眼',
    featureNotes,
  )
  const mouthMask = buildFeatureMask(
    geometry,
    width,
    height,
    geometry.mouthContour,
    geometry.mouth,
    8,
    8,
    faceExpanded,
    '嘴部',
    featureNotes,
  )
  notes.push(...featureNotes)

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
    /** Optional last step on the finished layer canvas. */
    transform?: (canvas: HTMLCanvasElement, box: Rect) => void,
  ) {
    const box = clampRect(bbox, width, height)
    if (box.w < 8 || box.h < 8) {
      // A degenerate bbox means the geometry behind this layer is broken.
      // Say so, otherwise the character silently comes out missing a part.
      notes.push(`${nameZh}区域过小（${Math.round(box.w)}×${Math.round(box.h)}），已跳过该图层。`)
      return
    }
    const layerCanvas = extractLayerCanvas(source, mask, box, feather)
    transform?.(layerCanvas, box)
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

  // The head turns; the body does not. The hair slices are cut from the same
  // hair as the head layer and travel with it, so a copy of that hair left in
  // the body stays behind when the head turns — a second head of hair peeking
  // out from behind. Take the hair the slices own out of the body layer.
  //
  // Only the slices' own hair goes. Hair that reaches past the head box
  // (the long tail) exists in the body layer alone, and removing it would
  // delete hair that nothing else draws. The jaw stays too: the runtime head
  // mask fades the head out above the chin, so the body is what draws it.
  let bodyMask = foreground
  const hairOwners = [hairMasks.front, hairMasks.back].filter(Boolean) as Mask[]
  if (hairOwners.length) {
    let owned = hairOwners[0]
    for (const part of hairOwners.slice(1)) owned = unionMask(owned, part)
    bodyMask = subtractMask(foreground, owned)
  }

  await addLayer(
    'body',
    '身体与衣领',
    bodyMask,
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
  // The mouth and the cavity behind it share one grid, so both are cut from
  // the same rectangle. The rectangle is a little larger than the lips: the
  // upper lip has to travel upwards when the jaw drops, and the teeth band
  // needs somewhere to live.
  const mouthBox = mouthMask ? maskBBox(mouthMask) : null
  const innerLipUsable = Boolean(mouthMask) && isUsableInnerLip(geometry)
  // The aperture is the slit the lips part along. Cutting it from the inner
  // lip ring is wrong for a closed mouth: that ring is a two-pixel sliver with
  // twenty corners, and stretching it gives a jagged hole. A smooth lens along
  // the lip line opens cleanly.
  const apertureMask = innerLipUsable
    ? maskFromEllipse(
        width,
        height,
        {
          x: (geometry.mouthCornerL.x + geometry.mouthCornerR.x) / 2,
          y: (geometry.mouthInnerUpperMid.y + geometry.mouthInnerLowerMid.y) / 2,
        },
        Math.max(6, (geometry.mouthCornerR.x - geometry.mouthCornerL.x) * MOUTH_APERTURE_WIDTH),
        Math.max(2, (geometry.mouthLowerMid.y - geometry.mouthUpperMid.y) * MOUTH_APERTURE_HEIGHT),
      )
    : null
  if (mouthMask && mouthBox && maskCoverage(mouthMask, 16) > 0.0002) {
    const box = expandRect(mouthBox, 0.18, 6)
    const mouthControl = controlFromGeometry(geometry)
    await addLayer(
      'mouth',
      '嘴',
      mouthMask,
      box,
      geometry.mouthCenter,
      29,
      'head',
      0.65,
      1.5,
      apertureMask
        ? (canvas, clipped) => {
            punchMouthAperture(canvas, apertureMask, clipped)
            softenMouthCorners(canvas, mouthControl, clipped)
          }
        : undefined,
    )
    if (apertureMask) {
      // The cavity sits between the head and the lips: it is what the lips
      // reveal when the mouth opens.
      const cavityBox = expandRect(mouthBox, 0.18, 6)
      const cavityCanvas = createMouthCavityCanvas({
        source,
        mask: mouthMask,
        box: clampRect(cavityBox, width, height),
        control: mouthControl,
        reference: options.mouthReference,
      })
      const blob = await canvasToBlob(cavityCanvas)
      layers.push({
        id: 'mouthCavity',
        nameZh: '口腔',
        blob,
        bbox: clampRect(cavityBox, width, height),
        pivot: geometry.mouthCenter,
        z: 28.5,
        parent: 'head',
        depth: 0.6,
        textureId: textureIdFor('mouthCavity'),
      })
    } else {
      notes.push('内唇关键点不可用，嘴部保持静态贴图。')
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
