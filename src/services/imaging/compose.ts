import type { CharacterRecord, LayerDef, LayerId, Rect } from '../../types/character'
import type { Mask } from '../cv/masks'
import {
  createCanvas,
  dilateMask,
  maskBBox,
  maskCoverage,
  maskFillRatio,
  maskFromCanvasAlpha,
  maskToCanvas,
  subtractMask,
  unionMask,
} from '../cv/masks'
import { clampRect, expandRect } from '../cv/geometry'
import { canvasFromBlob, canvasToBlob, cropCanvas } from './canvas'
import { partSpec, type RedrawPart } from '../agent/redrawPlan'

export function layerOrderFor(record: CharacterRecord): LayerId[] {
  const fromManifest = record.manifest.layerOrder.filter(
    (id) => Boolean(record.layers[id] && record.manifest.layers[id]),
  )
  if (fromManifest.length) return fromManifest
  return Object.values(record.manifest.layers)
    .filter((def): def is LayerDef => Boolean(def))
    .sort((a, b) => a.z - b.z)
    .map((def) => def.id)
    .filter((id) => Boolean(record.layers[id]))
}

export function resolveLayerId(record: CharacterRecord, preferred: LayerId): LayerId | null {
  if (record.layers[preferred] && record.manifest.layers[preferred]) return preferred
  if (preferred === 'head') {
    for (const fallback of ['headBase', 'face'] as LayerId[]) {
      if (record.layers[fallback] && record.manifest.layers[fallback]) return fallback
    }
  }
  return null
}

export function partExists(record: CharacterRecord, part: RedrawPart): boolean {
  return partSpec(part).layers.some((entry) => resolveLayerId(record, entry.id) !== null)
}

export async function composeRecordCanvas(record: CharacterRecord): Promise<HTMLCanvasElement> {
  const { width, height } = record.manifest.canvas
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D')
  for (const id of layerOrderFor(record)) {
    const blob = record.layers[id]
    const def = record.manifest.layers[id]
    if (!blob || !def) continue
    const layer = await canvasFromBlob(blob)
    ctx.drawImage(layer, def.offset.x, def.offset.y, def.size.w, def.size.h)
  }
  return canvas
}

async function layerAlphaMask(record: CharacterRecord, id: LayerId): Promise<Mask | null> {
  const blob = record.layers[id]
  const def = record.manifest.layers[id]
  if (!blob || !def) return null
  const { width, height } = record.manifest.canvas
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const layer = await canvasFromBlob(blob)
  ctx.drawImage(layer, def.offset.x, def.offset.y, def.size.w, def.size.h)
  return maskFromCanvasAlpha(canvas)
}

/**
 * Builds the edit region for a part. Occluding layers are subtracted so the
 * model edits visible pixels instead of repainting a covered face or neck.
 */
export async function composePartMask(
  record: CharacterRecord,
  part: RedrawPart,
): Promise<Mask | null> {
  const info = partSpec(part)
  let combined: Mask | null = null
  for (const entry of info.layers) {
    const id = resolveLayerId(record, entry.id)
    if (!id) continue
    let mask = await layerAlphaMask(record, id)
    if (!mask) continue
    for (const subtract of entry.subtract ?? []) {
      const subtractId = resolveLayerId(record, subtract)
      if (!subtractId) continue
      const occluder = await layerAlphaMask(record, subtractId)
      if (occluder) mask = subtractMask(mask, occluder)
    }
    combined = combined ? unionMask(combined, mask) : mask
  }
  if (!combined) return null
  const bbox = maskBBox(combined)
  if (!bbox) return null
  // A layer whose alpha fills its whole bounding box is a rectangle, not a
  // cut-out. Editing it would paste an opaque background back into the record.
  if (maskFillRatio(combined, bbox) > 0.995) {
    throw new Error(
      `「${info.labelZh}」的分层蒙版几乎是一整块矩形，抠图/分割可能失败。请重新生成角色后再试。`,
    )
  }
  const radius = Math.max(2, Math.round(Math.min(bbox.w, bbox.h) * 0.015))
  const expanded = dilateMask(combined, radius)
  return maskCoverage(expanded, 16) > 0.0005 ? expanded : null
}

export async function maskToProviderPng(
  mask: Mask,
  width: number,
  height: number,
  featherPx: number,
  invert: boolean,
): Promise<Blob> {
  const maskCanvas = maskToCanvas(mask, { x: 0, y: 0, w: width, h: height }, featherPx)
  if (!invert) return canvasToBlob(maskCanvas)
  // OpenAI edits treat fully transparent pixels as the area to repaint.
  const inverted = createCanvas(width, height)
  const ctx = inverted.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.drawImage(maskCanvas, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  return canvasToBlob(inverted)
}

export function scaleCanvas(
  source: HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D')
  ctx.drawImage(source, 0, 0, width, height)
  return canvas
}

/**
 * The layered record has a transparent background, while image-edit models are
 * trained on opaque photos. Flattening onto a neutral colour gives the model a
 * stable context; the rebuild's matting removes it again.
 */
export function flattenOnColor(source: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const canvas = createCanvas(source.width, source.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(source, 0, 0)
  return canvas
}

export async function scaleBlobToCanvas(
  blob: Blob,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  const source = await canvasFromBlob(blob)
  return scaleCanvas(source, width, height)
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return canvasToBlob(canvas)
}

export interface PartCrop {
  canvas: HTMLCanvasElement
  rect: Rect
}

export async function cropPartImage(
  composite: HTMLCanvasElement,
  mask: Mask,
  paddingRatio = 0.12,
): Promise<PartCrop | null> {
  const bbox = maskBBox(mask)
  if (!bbox) return null
  const rect = clampRect(expandRect(bbox, paddingRatio, 12), composite.width, composite.height)
  return { canvas: cropCanvas(composite, rect), rect }
}

/**
 * Reference-edit providers cannot take a mask, so the reference image itself
 * has to carry the "this is only the hair layer" message. Drawing just the
 * part layers on a plain background is far more reliable than sending the
 * whole character and asking the model to ignore the face and body.
 */
export async function composePartReference(
  record: CharacterRecord,
  part: RedrawPart,
  mask?: Mask | null,
): Promise<PartCrop | null> {
  const info = partSpec(part)
  const partMask = mask ?? (await composePartMask(record, part))
  if (!partMask) return null
  const { width, height } = record.manifest.canvas
  const full = createCanvas(width, height)
  const ctx = full.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#f5f5f5'
  ctx.fillRect(0, 0, width, height)
  for (const entry of info.layers) {
    const id = resolveLayerId(record, entry.id)
    if (!id) continue
    const blob = record.layers[id]
    const def = record.manifest.layers[id]
    if (!blob || !def) continue
    const layer = await canvasFromBlob(blob)
    ctx.drawImage(layer, def.offset.x, def.offset.y, def.size.w, def.size.h)
  }
  return cropPartImage(full, partMask)
}

export async function pasteCropBack(
  composite: HTMLCanvasElement,
  edited: HTMLCanvasElement,
  rect: Rect,
  mask: Mask,
  featherPx: number,
): Promise<HTMLCanvasElement> {
  const out = createCanvas(composite.width, composite.height)
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D')
  ctx.drawImage(composite, 0, 0)

  const patch = createCanvas(rect.w, rect.h)
  const patchCtx = patch.getContext('2d')
  if (!patchCtx) throw new Error('浏览器不支持 Canvas 2D')
  patchCtx.drawImage(edited, 0, 0, rect.w, rect.h)
  const maskCanvas = maskToCanvas(mask, rect, featherPx)
  patchCtx.globalCompositeOperation = 'destination-in'
  patchCtx.drawImage(maskCanvas, 0, 0)
  patchCtx.globalCompositeOperation = 'source-over'

  ctx.drawImage(patch, rect.x, rect.y)
  return out
}
