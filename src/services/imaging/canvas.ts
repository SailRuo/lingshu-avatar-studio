import type { Rect } from '../../types/character'
import { clampRect } from '../cv/geometry'
import type { Mask } from '../cv/masks'
import { maskToCanvas } from '../cv/masks'

export interface SourceCanvas {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

export async function canvasFromBlob(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas
}

export async function canvasFromBlobScaled(blob: Blob, maxSide = 1536): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = 'image/png',
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas 导出失败'))),
      type,
      quality,
    )
  })
}

export function cropCanvas(source: HTMLCanvasElement, rect: Rect): HTMLCanvasElement {
  const box = clampRect(rect, source.width, source.height)
  const canvas = document.createElement('canvas')
  canvas.width = box.w
  canvas.height = box.h
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)
  return canvas
}

export function extractLayerCanvas(
  source: HTMLCanvasElement,
  mask: Mask,
  bbox: Rect,
  featherPx = 1.5,
): HTMLCanvasElement {
  const box = clampRect(bbox, source.width, source.height)
  const layer = document.createElement('canvas')
  layer.width = box.w
  layer.height = box.h
  const ctx = layer.getContext('2d')
  if (!ctx) return layer
  ctx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)
  const maskCanvas = maskToCanvas(mask, box, featherPx)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(maskCanvas, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  return layer
}

export async function makeThumbnail(
  source: HTMLCanvasElement,
  maxWidth = 560,
  maxHeight = 760,
): Promise<Blob> {
  const scale = Math.min(1, maxWidth / source.width, maxHeight / source.height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(source.height * scale))
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvasToBlob(canvas, 'image/jpeg', 0.86)
}

export async function resizeImageBlob(blob: Blob, maxSide = 1024): Promise<Blob> {
  const canvas = await canvasFromBlobScaled(blob, maxSide)
  return canvasToBlob(canvas, 'image/jpeg', 0.88)
}
