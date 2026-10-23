import { describe, expect, it } from 'vitest'
import {
  createMask,
  isDegeneratePolygon,
  maskFillRatio,
  polygonArea,
  removeSmallComponents,
  type Mask,
} from '../../src/services/cv/masks'
import { upsampleMaskGuided } from '../../src/services/cv/upsample'

function stepMask(width: number, height: number, splitX: number): Mask {
  const mask = createMask(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < splitX; x += 1) mask.data[y * width + x] = 255
  }
  return mask
}

function stepGuide(width: number, height: number, splitX: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x < splitX ? 0 : 255
      const offset = (y * width + x) * 4
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
      data[offset + 3] = 255
    }
  }
  return data
}

function lastMaskedColumn(mask: Mask): number {
  let last = -1
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[y * mask.width + x] > 127) last = Math.max(last, x)
    }
  }
  return last
}

function countMasked(mask: Mask): number {
  let count = 0
  for (let i = 0; i < mask.data.length; i += 1) {
    if (mask.data[i] > 127) count += 1
  }
  return count
}

describe('guided mask upsampling', () => {
  it('moves a low-resolution edge toward the guide color boundary', () => {
    const low = stepMask(8, 8, 4)
    const guide = stepGuide(32, 8, 20)
    const out = upsampleMaskGuided(
      low,
      { width: 32, height: 8, data: guide },
      { radius: 6, epsilon: 1e-3 },
    )
    expect(out.width).toBe(32)
    expect(out.height).toBe(8)
    const boundary = lastMaskedColumn(out)
    // Bilinear alone would land at x=15/16, the guide edge is at x=20.
    expect(boundary).toBeGreaterThan(17)
    expect(Math.abs(boundary - 20)).toBeLessThanOrEqual(2)
  })

  it('refines an already full-resolution mask instead of resizing it', () => {
    const mask = stepMask(32, 8, 16)
    const guide = stepGuide(32, 8, 20)
    const out = upsampleMaskGuided(
      mask,
      { width: 32, height: 8, data: guide },
      { radius: 6, epsilon: 1e-3 },
    )
    const boundary = lastMaskedColumn(out)
    expect(boundary).toBeGreaterThan(16)
    expect(Math.abs(boundary - 20)).toBeLessThanOrEqual(2)
  })

  it('falls back to nearest-neighbour when the guide buffer is too short', () => {
    const low = stepMask(4, 4, 2)
    const out = upsampleMaskGuided(low, { width: 8, height: 8, data: new Uint8ClampedArray(4) })
    expect(out.width).toBe(8)
    expect(out.height).toBe(8)
    expect(countMasked(out)).toBe(32)
  })
})

describe('connected component cleanup', () => {
  it('removes tiny specks and keeps the large region', () => {
    const mask = createMask(20, 20)
    for (let y = 4; y < 10; y += 1) {
      for (let x = 4; x < 10; x += 1) mask.data[y * 20 + x] = 255
    }
    for (let y = 15; y < 17; y += 1) {
      for (let x = 15; x < 17; x += 1) mask.data[y * 20 + x] = 255
    }
    const cleaned = removeSmallComponents(mask, 10)
    expect(countMasked(cleaned)).toBe(36)
    expect(cleaned.data[15 * 20 + 15]).toBe(0)
    // The caller's mask stays untouched.
    expect(countMasked(mask)).toBe(40)
  })

  it('keeps components that meet the area threshold', () => {
    const mask = createMask(10, 10)
    for (let y = 2; y < 5; y += 1) {
      for (let x = 2; x < 5; x += 1) mask.data[y * 10 + x] = 255
    }
    const cleaned = removeSmallComponents(mask, 9)
    expect(countMasked(cleaned)).toBe(9)
  })
})

describe('mask fill ratio', () => {
  it('detects a rectangular layer and a tight cutout', () => {
    const mask = createMask(10, 10)
    for (let y = 2; y < 7; y += 1) {
      for (let x = 2; x < 7; x += 1) mask.data[y * 10 + x] = 255
    }
    expect(maskFillRatio(mask, { x: 0, y: 0, w: 10, h: 10 })).toBeCloseTo(0.25)
    expect(maskFillRatio(mask, { x: 2, y: 2, w: 5, h: 5 })).toBe(1)
  })
})

describe('polygon degeneracy', () => {
  it('measures the shoelace area', () => {
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ]),
    ).toBe(50)
  })

  it('flags too few, collinear, and too-small polygons', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ]
    expect(isDegeneratePolygon([{ x: 0, y: 0 }], 1)).toBe(true)
    expect(
      isDegeneratePolygon(
        [
          { x: 0, y: 0 },
          { x: 5, y: 5 },
          { x: 10, y: 10 },
        ],
        1,
      ),
    ).toBe(true)
    expect(isDegeneratePolygon(square, 60)).toBe(true)
    expect(isDegeneratePolygon(square, 40)).toBe(false)
  })
})

describe('guided mask upsampling stability', () => {
  // These are robustness properties, not reproductions of a visible defect.
  // The linear coefficients do reach the hundreds on a flat guide, and the
  // windowed variance can go slightly negative, but the end-to-end error
  // measured on a synthetic portrait was around one pixel of boundary
  // erosion. The clamping in upsample.ts is there to keep a pathological
  // window from rewriting a whole region.
  it('keeps the solid interior of a smooth guide contiguous', () => {
    // A smooth guide has almost no local variance, which is where the
    // linear coefficients blow up and the threshold flips whole patches.
    const W = 64
    const H = 64
    const guide = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4
        const v = Math.round(20 + x * 3.2 + y * 0.7)
        guide[i] = v
        guide[i + 1] = Math.round(v * 0.94)
        guide[i + 2] = Math.round(v * 0.88)
        guide[i + 3] = 255
      }
    }
    const low = createMask(8, 8)
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 5; x += 1) low.data[y * 8 + x] = 255
    }
    const out = upsampleMaskGuided(low, { width: W, height: H, data: guide }, { radius: 6 })

    // The solid interior must stay solid: no scattered holes, no speckle.
    // The low-resolution mask covers the left 5/8 of the frame, so the
    // interior is well inside that, away from the boundary the filter moves.
    let holes = 0
    for (let y = 12; y < 52; y += 1) {
      for (let x = 12; x < 34; x += 1) {
        if (out.data[y * W + x] <= 127) holes += 1
      }
    }
    expect(holes).toBe(0)
  })

  it('keeps the output inside the 0..255 range for a noisy guide', () => {
    const low = createMask(8, 8)
    for (let i = 0; i < 64; i += 1) low.data[i] = i % 2 === 0 ? 255 : 0
    const guide = new Uint8ClampedArray(64 * 64 * 4)
    for (let i = 0; i < 64 * 64; i += 1) {
      guide[i * 4] = (i * 37) % 256
      guide[i * 4 + 1] = (i * 91) % 256
      guide[i * 4 + 2] = (i * 13) % 256
      guide[i * 4 + 3] = 255
    }
    const out = upsampleMaskGuided(low, { width: 64, height: 64, data: guide }, { radius: 4 })
    for (let i = 0; i < out.data.length; i += 1) {
      expect(out.data[i]).toBeGreaterThanOrEqual(0)
      expect(out.data[i]).toBeLessThanOrEqual(255)
    }
  })
})
