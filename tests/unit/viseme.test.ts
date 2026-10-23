import { describe, expect, it } from 'vitest'
import {
  analyzeMouthShapes,
  createFixedLoudness,
  MouthShapeSmoother,
  REST_SHAPE,
} from '../../src/services/audio/viseme'

const SAMPLE_RATE = 24000

/** A steady tone, used to emulate a vowel with a known formant region. */
function tone(hz: number, seconds: number, amplitude = 0.4): Float32Array {
  const count = Math.round(seconds * SAMPLE_RATE)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    samples[i] = Math.sin((i / SAMPLE_RATE) * Math.PI * 2 * hz) * amplitude
  }
  return samples
}

/**
 * Three resonances, the way a vowel is built from a source and a filter.
 * These are the F1/F2/F3 values of the English vowels.
 */
function vowel(formants: [number, number, number], seconds: number): Float32Array {
  const count = Math.round(seconds * SAMPLE_RATE)
  const samples = new Float32Array(count)
  const gains = [1, 0.6, 0.3]
  for (let i = 0; i < count; i += 1) {
    let value = 0
    for (let k = 0; k < formants.length; k += 1) {
      value += gains[k] * Math.sin((i / SAMPLE_RATE) * Math.PI * 2 * formants[k])
    }
    samples[i] = (value / 2) * 0.4
  }
  return samples
}

function shapeOf(samples: Float32Array) {
  const shapes = analyzeMouthShapes(samples, SAMPLE_RATE, {
    loudness: createFixedLoudness(0.25),
  })
  return shapes[Math.floor(shapes.length / 2)]
}

describe('mouth shape analysis', () => {
  it('keeps silence closed', () => {
    const shapes = analyzeMouthShapes(new Float32Array(SAMPLE_RATE), SAMPLE_RATE, {
      loudness: createFixedLoudness(0.4),
    })
    expect(shapes.length).toBeGreaterThan(10)
    for (const shape of shapes) {
      expect(shape.openness).toBe(0)
      expect(shape.viseme).toBe('rest')
    }
  })

  it('rounds the lips for a low formant tone', () => {
    const shapes = analyzeMouthShapes(tone(320, 0.4), SAMPLE_RATE, {
      loudness: createFixedLoudness(0.4),
    })
    const mid = shapes[Math.floor(shapes.length / 2)]
    expect(mid.viseme).toBe('round')
    expect(mid.roundness).toBeGreaterThan(0.5)
    expect(mid.width).toBeLessThan(0)
    expect(mid.openness).toBeGreaterThan(0.1)
  })

  it('opens wide for a mid formant tone', () => {
    const shapes = analyzeMouthShapes(tone(800, 0.4), SAMPLE_RATE, {
      loudness: createFixedLoudness(0.4),
    })
    const mid = shapes[Math.floor(shapes.length / 2)]
    expect(mid.viseme).toBe('wide')
    expect(mid.openness).toBeGreaterThan(0.4)
    expect(mid.roundness).toBeLessThan(0.2)
  })

  it('shows the teeth for a high frequency fricative', () => {
    const shapes = analyzeMouthShapes(tone(6000, 0.4), SAMPLE_RATE, {
      loudness: createFixedLoudness(0.4),
    })
    const mid = shapes[Math.floor(shapes.length / 2)]
    expect(mid.viseme).toBe('teeth')
    expect(mid.teeth).toBeGreaterThan(0.5)
    expect(mid.openness).toBeLessThan(0.4)
  })

  it('keeps a shape stable across a single noisy frame', () => {
    const smoother = new MouthShapeSmoother()
    const first = smoother.push({
      viseme: 'wide',
      openness: 0.8,
      width: 0.2,
      roundness: 0,
      teeth: 0,
      level: 0.9,
    })
    const second = smoother.push({
      viseme: 'round',
      openness: 0.4,
      width: -0.6,
      roundness: 1,
      teeth: 0,
      level: 0.5,
    })
    expect(first.openness).toBeGreaterThan(0)
    // A single contradicting frame must not flip the mouth.
    expect(second.viseme).toBe('wide')
  })

  it('returns the rest shape when nothing is playing', () => {
    const smoother = new MouthShapeSmoother()
    expect(smoother.push(REST_SHAPE).openness).toBe(0)
  })

  it('eases lip width, roundness and teeth instead of snapping', () => {
    const smoother = new MouthShapeSmoother()
    const round = {
      viseme: 'round' as const,
      openness: 0.5,
      width: -1,
      roundness: 1,
      teeth: 0,
      level: 0.5,
    }
    const first = smoother.push(round)
    expect(first.roundness).toBeGreaterThan(0)
    expect(first.roundness).toBeLessThan(1)
    expect(first.width).toBeGreaterThan(-1)
    let current = first
    for (let index = 0; index < 24; index += 1) current = smoother.push(round)
    expect(current.roundness).toBeGreaterThan(0.9)
    expect(current.width).toBeLessThan(-0.8)
  })

  it('separates the vowels by their formants', () => {
    // /i/ spreads the lips into a narrow slit.
    expect(shapeOf(vowel([270, 2290, 3010], 0.3)).viseme).toBe('narrow')
    // /a/ and /e/ drop the jaw.
    expect(shapeOf(vowel([730, 1090, 2440], 0.3)).viseme).toBe('wide')
    expect(shapeOf(vowel([530, 1840, 2480], 0.3)).viseme).toBe('wide')
    // /o/ and /u/ push the lips forward.
    const roundO = shapeOf(vowel([570, 840, 2410], 0.3))
    const roundU = shapeOf(vowel([300, 870, 2240], 0.3))
    expect(roundO.viseme).toBe('round')
    expect(roundU.viseme).toBe('round')
    expect(roundU.roundness).toBeGreaterThan(0.5)
    expect(roundU.width).toBeLessThan(0)
  })
})
