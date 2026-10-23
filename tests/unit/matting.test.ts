import { describe, expect, it } from 'vitest'
import {
  alphaToMask,
  imageDataToNchw,
  minMaxNormalize,
  resizeAlphaBilinear,
} from '../../src/services/cv/matting/preprocess'
import { RMBG_1_4, modelFileError } from '../../src/services/cv/matting/spec'

describe('RMBG preprocessing', () => {
  it('lays out RGBA pixels as normalized NCHW planes', () => {
    // 2x1: red, then a dark green. Mean 0.5 / std 1 maps 255 to 0.5.
    const image = {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 128, 0, 255]),
    }
    const out = imageDataToNchw(image, [0.5, 0.5, 0.5], [1, 1, 1])
    expect(out.length).toBe(6)
    expect(out[0]).toBeCloseTo(0.5)
    expect(out[1]).toBeCloseTo(-0.5)
    expect(out[2]).toBeCloseTo(-0.5)
    expect(out[3]).toBeCloseTo(128 / 255 - 0.5)
    expect(out[4]).toBeCloseTo(-0.5)
    expect(out[5]).toBeCloseTo(-0.5)
  })

  it('min-max normalizes the raw mask and treats a flat mask as empty', () => {
    const normalized = minMaxNormalize(new Float32Array([-1, 0, 1]))
    expect(Array.from(normalized)).toEqual([0, 0.5, 1])
    expect(Array.from(minMaxNormalize(new Float32Array([3, 3, 3])))).toEqual([0, 0, 0])
  })

  it('resizes the alpha plane bilinearly', () => {
    const out = resizeAlphaBilinear(new Float32Array([0, 1, 2, 3]), 2, 2, 4, 4)
    expect(out.length).toBe(16)
    expect(out[0]).toBeCloseTo(0)
    expect(out[15]).toBeCloseTo(3)
    // The interior columns/rows interpolate, so the middle is strictly between.
    expect(out[5]).toBeGreaterThan(0)
    expect(out[5]).toBeLessThan(3)
  })

  it('converts a float alpha to an 8-bit mask', () => {
    const mask = alphaToMask(new Float32Array([0, 0.5, 1]), 3, 1)
    expect(mask.width).toBe(3)
    expect(mask.height).toBe(1)
    expect(Array.from(mask.data)).toEqual([0, 128, 255])
  })
})

describe('RMBG model file validation', () => {
  it('accepts the 176 MB ONNX file', () => {
    expect(modelFileError({ name: 'model.onnx', size: 176 * 1024 * 1024 }, RMBG_1_4)).toBeNull()
  })

  it('rejects non-ONNX, tiny, and oversized files', () => {
    expect(modelFileError({ name: 'model.bin', size: 176 * 1024 * 1024 }, RMBG_1_4)).toContain(
      '.onnx',
    )
    expect(modelFileError({ name: 'model.onnx', size: 1024 }, RMBG_1_4)).toContain('太小')
    expect(
      modelFileError({ name: 'model.onnx', size: 600 * 1024 * 1024 }, RMBG_1_4),
    ).toContain('500 MB')
  })
})
