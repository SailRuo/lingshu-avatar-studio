import type { Point, Rect } from '../../types/character'
import { clamp, clampRect } from './geometry'
import type { SegmentationResult } from './segmenter'

export interface Mask {
  width: number
  height: number
  data: Uint8Array
}

export interface MaskBox extends Rect {
  coverage: number
}

export function createMask(width: number, height: number, value = 0): Mask {
  return { width, height, data: new Uint8Array(width * height).fill(value) }
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

export function maskFromPolygon(
  width: number,
  height: number,
  points: Point[],
  value = 255,
): Mask {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx || points.length < 3) return createMask(width, height)
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y)
    else ctx.lineTo(point.x, point.y)
  })
  ctx.closePath()
  ctx.fill()
  return maskFromCanvas(canvas, value)
}

export function maskFromEllipse(
  width: number,
  height: number,
  center: Point,
  radiusX: number,
  radiusY: number,
): Mask {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return createMask(width, height)
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.ellipse(center.x, center.y, Math.max(1, radiusX), Math.max(1, radiusY), 0, 0, Math.PI * 2)
  ctx.fill()
  return maskFromCanvas(canvas)
}

export function maskFromRect(width: number, height: number, rect: Rect): Mask {
  const mask = createMask(width, height)
  const box = clampRect(rect, width, height)
  for (let y = box.y; y < box.y + box.h; y += 1) {
    const row = y * width
    mask.data.fill(255, row + box.x, row + box.x + box.w)
  }
  return mask
}

export function maskFromCanvas(canvas: HTMLCanvasElement, value = 255): Mask {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const mask = createMask(canvas.width, canvas.height)
  if (!ctx) return mask
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 0; i < mask.data.length; i += 1) {
    mask.data[i] = image[i * 4 + 3] > 8 ? value : 0
  }
  return mask
}

export function resizeMaskNearest(mask: Mask, width: number, height: number): Mask {
  if (mask.width === width && mask.height === height) return mask
  const out = createMask(width, height)
  for (let y = 0; y < height; y += 1) {
    const srcY = Math.min(mask.height - 1, Math.floor((y / height) * mask.height))
    for (let x = 0; x < width; x += 1) {
      const srcX = Math.min(mask.width - 1, Math.floor((x / width) * mask.width))
      out.data[y * width + x] = mask.data[srcY * mask.width + srcX]
    }
  }
  return out
}

export function unionMask(a: Mask, b: Mask): Mask {
  const width = Math.min(a.width, b.width)
  const height = Math.min(a.height, b.height)
  const aa = a.width === width ? a : resizeMaskNearest(a, width, height)
  const bb = b.width === width ? b : resizeMaskNearest(b, width, height)
  const out = createMask(width, height)
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = Math.max(aa.data[i], bb.data[i])
  return out
}

export function intersectMask(a: Mask, b: Mask): Mask {
  const width = Math.min(a.width, b.width)
  const height = Math.min(a.height, b.height)
  const aa = a.width === width ? a : resizeMaskNearest(a, width, height)
  const bb = b.width === width ? b : resizeMaskNearest(b, width, height)
  const out = createMask(width, height)
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = Math.min(aa.data[i], bb.data[i])
  return out
}

export function subtractMask(a: Mask, b: Mask): Mask {
  const width = Math.min(a.width, b.width)
  const height = Math.min(a.height, b.height)
  const aa = a.width === width ? a : resizeMaskNearest(a, width, height)
  const bb = b.width === width ? b : resizeMaskNearest(b, width, height)
  const out = createMask(width, height)
  for (let i = 0; i < out.data.length; i += 1) {
    out.data[i] = Math.max(0, aa.data[i] - bb.data[i])
  }
  return out
}

export function dilateMask(mask: Mask, radiusPx: number): Mask {
  if (radiusPx <= 0) return mask
  const canvas = createCanvas(mask.width, mask.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return mask
  const image = ctx.createImageData(mask.width, mask.height)
  for (let i = 0; i < mask.data.length; i += 1) {
    image.data[i * 4] = 255
    image.data[i * 4 + 1] = 255
    image.data[i * 4 + 2] = 255
    image.data[i * 4 + 3] = mask.data[i]
  }
  ctx.putImageData(image, 0, 0)
  const outCanvas = createCanvas(mask.width, mask.height)
  const outCtx = outCanvas.getContext('2d')
  if (!outCtx) return mask
  try {
    outCtx.filter = `blur(${radiusPx}px)`
  } catch {
    // Canvas filter is unsupported in some old WebViews; fall back to the original mask.
  }
  outCtx.drawImage(canvas, 0, 0)
  const out = createMask(mask.width, mask.height)
  const data = outCtx.getImageData(0, 0, mask.width, mask.height).data
  for (let i = 0; i < out.data.length; i += 1) {
    out.data[i] = data[i * 4 + 3] > 12 ? 255 : 0
  }
  return out
}

export function maskBBox(mask: Mask, threshold = 32): MaskBox | null {
  let minX = mask.width
  let minY = mask.height
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let y = 0; y < mask.height; y += 1) {
    const row = y * mask.width
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[row + x] > threshold) {
        count += 1
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    coverage: count / (mask.width * mask.height),
  }
}

export function maskCoverage(mask: Mask, threshold = 128): number {
  let count = 0
  for (let i = 0; i < mask.data.length; i += 1) {
    if (mask.data[i] > threshold) count += 1
  }
  return count / (mask.width * mask.height)
}

export function maskToCanvas(mask: Mask, bbox: Rect, featherPx = 0): HTMLCanvasElement {
  const full = createCanvas(mask.width, mask.height)
  const fullCtx = full.getContext('2d')
  if (fullCtx) {
    const image = fullCtx.createImageData(mask.width, mask.height)
    for (let i = 0; i < mask.data.length; i += 1) {
      image.data[i * 4] = 255
      image.data[i * 4 + 1] = 255
      image.data[i * 4 + 2] = 255
      image.data[i * 4 + 3] = mask.data[i]
    }
    fullCtx.putImageData(image, 0, 0)
  }
  const box = clampRect(bbox, mask.width, mask.height)
  const out = createCanvas(box.w, box.h)
  const ctx = out.getContext('2d')
  if (!ctx) return out
  if (featherPx > 0) {
    try {
      ctx.filter = `blur(${featherPx}px)`
    } catch {
      // ignore unsupported filter
    }
  }
  ctx.drawImage(full, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)
  return out
}

export function categoriesToMask(
  segmentation: SegmentationResult,
  width: number,
  height: number,
  categoryIndices: Set<number>,
): Mask {
  const resized = resizeMaskNearest(
    { width: segmentation.width, height: segmentation.height, data: segmentation.categories },
    width,
    height,
  )
  const mask = createMask(width, height)
  for (let i = 0; i < resized.data.length; i += 1) {
    mask.data[i] = categoryIndices.has(resized.data[i]) ? 255 : 0
  }
  return mask
}

export function foregroundFromSegmentation(
  segmentation: SegmentationResult,
  width: number,
  height: number,
): Mask {
  const resized = resizeMaskNearest(
    { width: segmentation.width, height: segmentation.height, data: segmentation.categories },
    width,
    height,
  )
  const mask = createMask(width, height)
  for (let i = 0; i < resized.data.length; i += 1) {
    mask.data[i] = resized.data[i] > 0 ? 255 : 0
  }
  return mask
}

function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r1 - r2
  const dg = g1 - g2
  const db = b1 - b2
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

export function foregroundFromColorKey(canvas: HTMLCanvasElement, tolerance = 34): Mask | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const { width, height } = canvas
  const image = ctx.getImageData(0, 0, width, height).data
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ]
  const samples = corners.map(([x, y]) => {
    const i = (y * width + x) * 4
    return [image[i], image[i + 1], image[i + 2]]
  })
  const bg = samples.reduce(
    (acc, sample) => [acc[0] + sample[0] / 4, acc[1] + sample[1] / 4, acc[2] + sample[2] / 4],
    [0, 0, 0],
  )
  const mask = createMask(width, height)
  let count = 0
  for (let i = 0; i < width * height; i += 1) {
    const r = image[i * 4]
    const g = image[i * 4 + 1]
    const b = image[i * 4 + 2]
    const alpha = image[i * 4 + 3]
    const distance = colorDistance(r, g, b, bg[0], bg[1], bg[2])
    if (alpha > 16 && distance > tolerance) {
      mask.data[i] = 255
      count += 1
    }
  }
  const coverage = count / (width * height)
  if (coverage < 0.04 || coverage > 0.97) return null
  return mask
}

export function ellipseMaskForPoints(
  width: number,
  height: number,
  points: Point[],
  padX = 8,
  padY = 8,
): Mask {
  if (!points.length) return createMask(width, height)
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  return maskFromEllipse(
    width,
    height,
    { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    Math.max(8, (maxX - minX) / 2 + padX),
    Math.max(6, (maxY - minY) / 2 + padY),
  )
}

export function bboxWithPadding(rect: Rect, padding: number, width: number, height: number): Rect {
  return clampRect(
    {
      x: rect.x - padding,
      y: rect.y - padding,
      w: rect.w + padding * 2,
      h: rect.h + padding * 2,
    },
    width,
    height,
  )
}

export { clamp }
