import type { Mask } from './masks'

export interface MaskGuide {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface GuidedUpsampleOptions {
  /** Box-filter radius in guide pixels. */
  radius?: number
  /** Variance floor in normalized [0,1] RGB units. */
  epsilon?: number
}

const DEFAULT_EPSILON = 1e-3
/**
 * Upper bound for a linear coefficient.
 *
 * The filter drops the cross-channel terms of the covariance, so the estimate
 * is only an approximation. Where the guide is flat the denominator collapses
 * onto epsilon and the coefficient can shoot into the hundreds, which the
 * threshold then turns into a flipped region. Clamping keeps a pathological
 * window from rewriting the whole neighbourhood.
 */
const MAX_COEFFICIENT = 4

function clampCoefficient(value: number): number {
  return Math.max(-MAX_COEFFICIENT, Math.min(MAX_COEFFICIENT, value))
}

function createEmptyMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height) }
}

function resizeNearest(mask: Mask, width: number, height: number): Mask {
  const out = createEmptyMask(width, height)
  for (let y = 0; y < height; y += 1) {
    const srcY = Math.min(mask.height - 1, Math.floor((y / height) * mask.height))
    for (let x = 0; x < width; x += 1) {
      const srcX = Math.min(mask.width - 1, Math.floor((x / width) * mask.width))
      out.data[y * width + x] = mask.data[srcY * mask.width + srcX]
    }
  }
  return out
}

function upsampleBilinear(mask: Mask, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height)
  const scaleX = mask.width / width
  const scaleY = mask.height / height
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(mask.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(mask.height - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(mask.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(mask.width - 1, x0 + 1)
      const fx = sx - x0
      const v00 = mask.data[y0 * mask.width + x0] / 255
      const v10 = mask.data[y0 * mask.width + x1] / 255
      const v01 = mask.data[y1 * mask.width + x0] / 255
      const v11 = mask.data[y1 * mask.width + x1] / 255
      const top = v00 + (v10 - v00) * fx
      const bottom = v01 + (v11 - v01) * fx
      out[y * width + x] = top + (bottom - top) * fy
    }
  }
  return out
}

function buildIntegral(
  src: Float32Array,
  width: number,
  height: number,
  out: Float32Array,
): void {
  const stride = width + 1
  out.fill(0)
  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0
    const srcRow = (y - 1) * width
    const row = y * stride
    const previous = row - stride
    for (let x = 1; x <= width; x += 1) {
      rowSum += src[srcRow + x - 1]
      out[row + x] = out[previous + x] + rowSum
    }
  }
}

function buildProductIntegral(
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number,
  out: Float32Array,
): void {
  const stride = width + 1
  out.fill(0)
  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0
    const srcRow = (y - 1) * width
    const row = y * stride
    const previous = row - stride
    for (let x = 1; x <= width; x += 1) {
      rowSum += a[srcRow + x - 1] * b[srcRow + x - 1]
      out[row + x] = out[previous + x] + rowSum
    }
  }
}

function writeBoxMean(
  integral: Float32Array,
  width: number,
  height: number,
  radius: number,
  out: Float32Array,
): void {
  const stride = width + 1
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius)
    const y1 = Math.min(height - 1, y + radius)
    const top = y0 * stride
    const bottom = (y1 + 1) * stride
    const areaY = y1 - y0 + 1
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)
      const sum =
        integral[bottom + x1 + 1] -
        integral[top + x1 + 1] -
        integral[bottom + x0] +
        integral[top + x0]
      out[row + x] = sum / (areaY * (x1 - x0 + 1))
    }
  }
}

function windowMeanAt(
  integral: Float32Array,
  stride: number,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): number {
  const x0 = Math.max(0, x - radius)
  const x1 = Math.min(width - 1, x + radius)
  const y0 = Math.max(0, y - radius)
  const y1 = Math.min(height - 1, y + radius)
  const sum =
    integral[(y1 + 1) * stride + x1 + 1] -
    integral[y0 * stride + x1 + 1] -
    integral[(y1 + 1) * stride + x0] +
    integral[y0 * stride + x0]
  return sum / ((y1 - y0 + 1) * (x1 - x0 + 1))
}

function boxMeanInPlace(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
  integral: Float32Array,
): void {
  buildIntegral(src, width, height, integral)
  writeBoxMean(integral, width, height, radius, src)
}

/**
 * Upsamples a segmentation mask and snaps its edge to the guide image using a
 * guided filter (He et al.). A bigger segmentation model would be more
 * accurate, but it costs download size and runtime; the guide image already
 * contains the real hair and collar edges, so refining with it costs nothing.
 *
 * The filter runs per RGB channel with the cross-channel terms dropped (a
 * diagonal covariance approximation). That keeps the cost at O(W*H) with a
 * constant number of integral images instead of a 3x3 covariance inverse per
 * pixel.
 */
export function upsampleMaskGuided(
  mask: Mask,
  guide: MaskGuide,
  options: GuidedUpsampleOptions = {},
): Mask {
  const width = Math.max(1, Math.round(guide.width))
  const height = Math.max(1, Math.round(guide.height))
  if (
    !mask ||
    mask.width < 1 ||
    mask.height < 1 ||
    mask.data.length < mask.width * mask.height
  ) {
    return createEmptyMask(width, height)
  }
  if (guide.data.length < width * height * 4) return resizeNearest(mask, width, height)

  const count = width * height
  // The bilinear ramp is about `scale` pixels wide; the filter window has to
  // cover it or the edge cannot move all the way to the guide boundary.
  const scale = Math.max(width / Math.max(1, mask.width), height / Math.max(1, mask.height), 1)
  const radius = Math.max(
    1,
    Math.round(options.radius ?? Math.max(Math.min(width, height) * 0.004, scale * 1.5)),
  )
  const epsilon = options.epsilon ?? DEFAULT_EPSILON

  const p =
    mask.width === width && mask.height === height && mask.data.length >= count
      ? Float32Array.from(mask.data.subarray(0, count), (value) => value / 255)
      : upsampleBilinear(mask, width, height)

  const guideR = new Float32Array(count)
  const guideG = new Float32Array(count)
  const guideB = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    const offset = i * 4
    guideR[i] = guide.data[offset] / 255
    guideG[i] = guide.data[offset + 1] / 255
    guideB[i] = guide.data[offset + 2] / 255
  }

  const integral = new Float32Array((width + 1) * (height + 1))
  const stride = width + 1

  const meanR = new Float32Array(count)
  const meanG = new Float32Array(count)
  const meanB = new Float32Array(count)
  const varianceR = new Float32Array(count)
  const varianceG = new Float32Array(count)
  const varianceB = new Float32Array(count)
  const meanP = new Float32Array(count)

  buildIntegral(guideR, width, height, integral)
  writeBoxMean(integral, width, height, radius, meanR)
  buildIntegral(guideG, width, height, integral)
  writeBoxMean(integral, width, height, radius, meanG)
  buildIntegral(guideB, width, height, integral)
  writeBoxMean(integral, width, height, radius, meanB)

  buildProductIntegral(guideR, guideR, width, height, integral)
  writeBoxMean(integral, width, height, radius, varianceR)
  buildProductIntegral(guideG, guideG, width, height, integral)
  writeBoxMean(integral, width, height, radius, varianceG)
  buildProductIntegral(guideB, guideB, width, height, integral)
  writeBoxMean(integral, width, height, radius, varianceB)

  buildIntegral(p, width, height, integral)
  writeBoxMean(integral, width, height, radius, meanP)

  // varR/G/B and meanP are reused as the linear coefficients a and b.
  buildProductIntegral(p, guideR, width, height, integral)
  for (let i = 0; i < count; i += 1) {
    const x = i % width
    const y = (i - x) / width
    const covariance = windowMeanAt(integral, stride, width, height, x, y, radius)
    // Rounding error can push the windowed variance below zero. A negative
    // denominator flips the sign of the coefficient, which sends the whole
    // neighbourhood to the wrong side of the threshold.
    const variance = Math.max(0, varianceR[i] - meanR[i] * meanR[i])
    varianceR[i] = clampCoefficient(
      (covariance - meanR[i] * meanP[i]) / (variance + epsilon),
    )
  }
  buildProductIntegral(p, guideG, width, height, integral)
  for (let i = 0; i < count; i += 1) {
    const x = i % width
    const y = (i - x) / width
    const covariance = windowMeanAt(integral, stride, width, height, x, y, radius)
    const variance = Math.max(0, varianceG[i] - meanG[i] * meanG[i])
    varianceG[i] = clampCoefficient(
      (covariance - meanG[i] * meanP[i]) / (variance + epsilon),
    )
  }
  buildProductIntegral(p, guideB, width, height, integral)
  for (let i = 0; i < count; i += 1) {
    const x = i % width
    const y = (i - x) / width
    const covariance = windowMeanAt(integral, stride, width, height, x, y, radius)
    const variance = Math.max(0, varianceB[i] - meanB[i] * meanB[i])
    varianceB[i] = clampCoefficient(
      (covariance - meanB[i] * meanP[i]) / (variance + epsilon),
    )
  }

  for (let i = 0; i < count; i += 1) {
    meanP[i] -= varianceR[i] * meanR[i] + varianceG[i] * meanG[i] + varianceB[i] * meanB[i]
  }

  boxMeanInPlace(varianceR, width, height, radius, integral)
  boxMeanInPlace(varianceG, width, height, radius, integral)
  boxMeanInPlace(varianceB, width, height, radius, integral)
  boxMeanInPlace(meanP, width, height, radius, integral)

  const out = createEmptyMask(width, height)
  for (let i = 0; i < count; i += 1) {
    const value =
      varianceR[i] * guideR[i] +
      varianceG[i] * guideG[i] +
      varianceB[i] * guideB[i] +
      meanP[i]
    out.data[i] = value * 255 > 127 ? 255 : 0
  }
  return out
}
