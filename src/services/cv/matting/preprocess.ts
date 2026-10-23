import type { Mask } from '../masks'

export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/**
 * Converts RGBA pixels to the NCHW float tensor RMBG-1.4 expects. The
 * official preprocessing divides by 255 and normalizes with mean 0.5 / std 1,
 * which is equivalent to `(channel / 255 - mean) / std`.
 */
export function imageDataToNchw(
  image: RgbaImage,
  mean: [number, number, number],
  std: [number, number, number],
): Float32Array {
  const { width, height, data } = image
  const plane = width * height
  const out = new Float32Array(plane * 3)
  for (let i = 0; i < plane; i += 1) {
    const offset = i * 4
    out[i] = (data[offset] / 255 - mean[0]) / std[0]
    out[plane + i] = (data[offset + 1] / 255 - mean[1]) / std[1]
    out[plane * 2 + i] = (data[offset + 2] / 255 - mean[2]) / std[2]
  }
  return out
}

/**
 * The RMBG-1.4 reference implementation min-max normalizes the raw mask
 * instead of applying a sigmoid. A constant output (a failed or empty
 * inference) becomes an all-zero mask rather than a full-frame one.
 */
export function minMaxNormalize(values: Float32Array): Float32Array {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (value < min) min = value
    if (value > max) max = value
  }
  const out = new Float32Array(values.length)
  const range = max - min
  if (!Number.isFinite(range) || range < 1e-6) return out
  const scale = 1 / range
  for (let i = 0; i < values.length; i += 1) out[i] = (values[i] - min) * scale
  return out
}

/** Bilinear resize for a single-channel float plane, pixel-centre aligned. */
export function resizeAlphaBilinear(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Float32Array {
  const out = new Float32Array(dstWidth * dstHeight)
  if (srcWidth < 1 || srcHeight < 1 || dstWidth < 1 || dstHeight < 1) return out
  const scaleX = srcWidth / dstWidth
  const scaleY = srcHeight / dstHeight
  for (let y = 0; y < dstHeight; y += 1) {
    const sy = Math.min(srcHeight - 1, Math.max(0, (y + 0.5) * scaleY - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(srcHeight - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < dstWidth; x += 1) {
      const sx = Math.min(srcWidth - 1, Math.max(0, (x + 0.5) * scaleX - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(srcWidth - 1, x0 + 1)
      const fx = sx - x0
      const v00 = src[y0 * srcWidth + x0]
      const v10 = src[y0 * srcWidth + x1]
      const v01 = src[y1 * srcWidth + x0]
      const v11 = src[y1 * srcWidth + x1]
      const top = v00 + (v10 - v00) * fx
      const bottom = v01 + (v11 - v01) * fx
      out[y * dstWidth + x] = top + (bottom - top) * fy
    }
  }
  return out
}

export function alphaToMask(values: Float32Array, width: number, height: number): Mask {
  const data = new Uint8Array(width * height)
  const count = Math.min(data.length, values.length)
  for (let i = 0; i < count; i += 1) {
    const value = values[i]
    const scaled = value * 255
    data[i] = scaled <= 0 ? 0 : scaled >= 255 ? 255 : Math.round(scaled)
  }
  return { width, height, data }
}
