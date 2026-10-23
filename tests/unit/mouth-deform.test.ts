import { describe, expect, it } from 'vitest'
import {
  buildMouthField,
  deformMouthPositions,
  type MouthControl,
  type MouthShape,
} from '../../src/services/render/mouthDeform'

/**
 * A mouth of 80x40 pixels with a 60 pixel wide opening. The numbers are
 * arbitrary but the proportions are the ones of a drawn face: the opening is
 * a narrow band in the middle of the lips.
 */
const CONTROL: MouthControl = {
  upper: { x: 100, y: 38 },
  lower: { x: 100, y: 62 },
  cornerL: { x: 70, y: 50 },
  cornerR: { x: 130, y: 50 },
  innerUpper: { x: 100, y: 47 },
  innerLower: { x: 100, y: 53 },
}

const RECT = { x: 60, y: 30, w: 80, h: 40 }
const COLS = 24
const ROWS = 16

function field() {
  return buildMouthField({ rect: RECT, cols: COLS, rows: ROWS, control: CONTROL })
}

function shape(partial: Partial<MouthShape>): MouthShape {
  return {
    viseme: 'rest',
    openness: 0,
    width: 0,
    roundness: 0,
    teeth: 0,
    level: 0,
    ...partial,
  }
}

function deform(input: MouthShape) {
  const built = field()
  const out = new Float32Array(built.base.length)
  deformMouthPositions(built.base, built.weights, CONTROL, input, out)
  return { base: built.base, out, weights: built.weights }
}

describe('mouth deformation field', () => {
  it('does not move a single vertex when the mouth is closed', () => {
    const { base, out } = deform(shape({}))
    for (let i = 0; i < base.length; i += 1) {
      expect(out[i]).toBeCloseTo(base[i], 6)
    }
  })

  it('does not move a single vertex when only the openness is zero', () => {
    const { base, out } = deform(shape({ openness: 0 }))
    for (let i = 0; i < base.length; i += 1) {
      expect(out[i]).toBeCloseTo(base[i], 6)
    }
  })

  it('separates the upper and the lower lip when the mouth opens', () => {
    const { base, out, weights } = deform(shape({ openness: 1 }))
    let upperMoved = 0
    let lowerMoved = 0
    for (let i = 0; i < weights.upper.length; i += 1) {
      const dy = out[i * 2 + 1] - base[i * 2 + 1]
      if (weights.upper[i] > 0.99 && weights.corner[i] < 0.01) {
        expect(dy).toBeLessThan(0)
        upperMoved += 1
      }
      if (weights.lower[i] > 0.99 && weights.corner[i] < 0.01) {
        expect(dy).toBeGreaterThan(0)
        lowerMoved += 1
      }
    }
    expect(upperMoved).toBeGreaterThan(10)
    expect(lowerMoved).toBeGreaterThan(10)
  })

  it('opens the gap between the lips when the mouth opens', () => {
    const closed = deform(shape({}))
    const open = deform(shape({ openness: 1 }))
    const gapOf = (run: ReturnType<typeof deform>) => {
      const column = Math.floor(COLS / 2)
      let upperEdge = -Infinity
      let lowerEdge = Infinity
      for (let j = 0; j < ROWS; j += 1) {
        const i = j * COLS + column
        if (run.weights.upper[i] > 0.99) upperEdge = Math.max(upperEdge, run.out[i * 2 + 1])
        if (run.weights.lower[i] > 0.99) lowerEdge = Math.min(lowerEdge, run.out[i * 2 + 1])
      }
      return lowerEdge - upperEdge
    }
    expect(gapOf(open)).toBeGreaterThan(gapOf(closed) + 1)
  })

  it('pushes the corners outwards for a wide mouth and inwards for a narrow one', () => {
    const { base, out, weights } = deform(shape({ width: 1 }))
    const cornerVertices = () => {
      let left = -1
      let right = -1
      let leftWeight = 0
      let rightWeight = 0
      for (let i = 0; i < weights.corner.length; i += 1) {
        if (weights.corner[i] < 0.2) continue
        if (base[i * 2] < CONTROL.cornerL.x + 6) {
          if (weights.corner[i] > leftWeight) {
            leftWeight = weights.corner[i]
            left = i
          }
        } else if (base[i * 2] > CONTROL.cornerR.x - 6) {
          if (weights.corner[i] > rightWeight) {
            rightWeight = weights.corner[i]
            right = i
          }
        }
      }
      return { left, right }
    }
    const { left, right } = cornerVertices()
    expect(left).toBeGreaterThanOrEqual(0)
    expect(right).toBeGreaterThanOrEqual(0)
    expect(out[left * 2] - base[left * 2]).toBeLessThan(0)
    expect(out[right * 2] - base[right * 2]).toBeGreaterThan(0)

    const narrow = deform(shape({ width: -1 }))
    expect(narrow.out[left * 2] - narrow.base[left * 2]).toBeGreaterThan(0)
    expect(narrow.out[right * 2] - narrow.base[right * 2]).toBeLessThan(0)
  })

  it('pulls the corners towards the middle for a rounded mouth', () => {
    const { base, out, weights } = deform(shape({ roundness: 1 }))
    let checked = 0
    for (let i = 0; i < weights.corner.length; i += 1) {
      if (weights.corner[i] < 0.2) continue
      const dx = out[i * 2] - base[i * 2]
      if (base[i * 2] < CONTROL.cornerL.x + 6) {
        expect(dx).toBeGreaterThan(0)
        checked += 1
      }
      if (base[i * 2] > CONTROL.cornerR.x - 6) {
        expect(dx).toBeLessThan(0)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('never moves a vertex further than the mouth is wide', () => {
    // Regression: the pout contraction used to be a length times a distance,
    // which threw the outer vertices several hundred pixels sideways and
    // smeared the lips across the whole face. Every displacement has to stay
    // proportional to the mouth.
    const mouthWidth = CONTROL.cornerR.x - CONTROL.cornerL.x
    const limit = mouthWidth * 0.5
    const cases = [
      shape({ openness: 1 }),
      shape({ openness: 1, width: 1 }),
      shape({ openness: 1, width: -1 }),
      shape({ openness: 1, roundness: 1 }),
      shape({ openness: 1, roundness: 1, width: 1 }),
      shape({ openness: 1, teeth: 1 }),
    ]
    for (const s of cases) {
      const { base, out } = deform(s)
      for (let i = 0; i < base.length / 2; i += 1) {
        const dx = out[i * 2] - base[i * 2]
        const dy = out[i * 2 + 1] - base[i * 2 + 1]
        expect(Math.abs(dx)).toBeLessThanOrEqual(limit)
        expect(Math.abs(dy)).toBeLessThanOrEqual(limit)
      }
    }
  })

  it('lifts the upper lip further when the teeth should show', () => {
    const plain = deform(shape({ openness: 0.6 }))
    const withTeeth = deform(shape({ openness: 0.6, teeth: 1 }))
    const top = Math.floor(ROWS * 0.2)
    let plainDy = 0
    let teethDy = 0
    for (let i = 0; i < plain.weights.upper.length; i += 1) {
      if (i % COLS !== Math.floor(COLS / 2)) continue
      if (i >= COLS * top) continue
      plainDy = Math.min(plainDy, plain.out[i * 2 + 1] - plain.base[i * 2 + 1])
      teethDy = Math.min(teethDy, withTeeth.out[i * 2 + 1] - withTeeth.base[i * 2 + 1])
    }
    expect(teethDy).toBeLessThan(plainDy)
  })

  it('keeps the weights a partition of unity so the mouth cannot tear', () => {
    const { weights } = field()
    for (let i = 0; i < weights.upper.length; i += 1) {
      expect(weights.upper[i] + weights.lower[i]).toBeCloseTo(1, 6)
      expect(weights.upper[i]).toBeGreaterThanOrEqual(0)
      expect(weights.upper[i]).toBeLessThanOrEqual(1)
      expect(weights.corner[i]).toBeGreaterThanOrEqual(0)
      expect(weights.side[i]).toBeGreaterThanOrEqual(-1)
      expect(weights.side[i]).toBeLessThanOrEqual(1)
    }
  })

  it('mixes the corner motion into the lip motion instead of replacing it', () => {
    const { base, out, weights } = deform(shape({ openness: 1, width: 1 }))
    let lipLift = 0
    let lipDrop = 0
    for (let i = 0; i < weights.upper.length; i += 1) {
      if (weights.corner[i] > 0.01) continue
      const dy = out[i * 2 + 1] - base[i * 2 + 1]
      if (weights.upper[i] > 0.99) lipLift = Math.min(lipLift, dy)
      if (weights.lower[i] > 0.99) lipDrop = Math.max(lipDrop, dy)
    }
    expect(lipLift).toBeLessThan(0)
    expect(lipDrop).toBeGreaterThan(0)
    let checked = 0
    for (let i = 0; i < weights.corner.length; i += 1) {
      if (weights.corner[i] < 0.2) continue
      const dy = out[i * 2 + 1] - base[i * 2 + 1]
      // The corner belongs to both lips, so its motion is a blend of the two
      // and can never be stronger than the strongest of them.
      expect(dy).toBeGreaterThanOrEqual(lipLift)
      expect(dy).toBeLessThanOrEqual(lipDrop)
      checked += 1
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('leaves the grid untouched outside of the mouth', () => {
    const built = field()
    const out = new Float32Array(built.base.length)
    deformMouthPositions(built.base, built.weights, CONTROL, shape({ openness: 1 }), out)
    let moved = 0
    for (let i = 0; i < built.weights.upper.length; i += 1) {
      if (built.weights.upper[i] === 0 && built.weights.lower[i] === 0) {
        expect(out[i * 2]).toBeCloseTo(built.base[i * 2], 6)
        expect(out[i * 2 + 1]).toBeCloseTo(built.base[i * 2 + 1], 6)
      } else {
        moved += 1
      }
    }
    expect(moved).toBeGreaterThan(0)
  })
})
