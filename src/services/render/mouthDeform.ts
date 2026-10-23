/**
 * Continuous mouth deformation.
 *
 * The mouth used to be five pre-drawn textures that were cross-faded into
 * each other, so the lip could only ever be one of five shapes. This module
 * replaces that with a deformation field: a grid of vertices over the mouth
 * area, a set of per-vertex weights that say which part of the mouth every
 * vertex belongs to, and a handful of continuous parameters (openness, width,
 * roundness, teeth) that move those vertices.
 *
 * Everything in here is pure: no DOM, no PixiJS, no canvas. The weights are
 * computed once when the character is imported and stored in the character
 * pack, so the runtime only has to run the weighted sum once per frame.
 */

import type { MouthShape } from '../audio/viseme'
import type { Point, Rect } from '../../types/character'

export type { MouthShape }

/**
 * The control points of the mouth.
 *
 * `upper` / `lower` are the mid points of the outer lips, `cornerL` /
 * `cornerR` the corners of the mouth and `innerUpper` / `innerLower` the mid
 * points of the inner lips (the edge of the actual opening).
 */
export interface MouthControl {
  upper: Point
  lower: Point
  cornerL: Point
  cornerR: Point
  innerUpper: Point
  innerLower: Point
}

/**
 * Per-vertex weights of the deformation field.
 *
 * - `upper`: how strongly the vertex follows the upper lip. 1 means the vertex
 *   moves rigidly with the upper lip, 0 means it does not move at all.
 * - `lower`: the same for the lower lip.
 * - `corner`: how strongly the vertex follows the mouth corners. The corners
 *   spread apart (`width`) or pull together (`roundness`).
 * - `side`: the signed horizontal position inside the mouth, -1 at the left
 *   edge, 0 in the middle, +1 at the right edge. It turns a single corner
 *   displacement into a left/right pair.
 */
export interface MouthWeights {
  upper: Float32Array
  lower: Float32Array
  corner: Float32Array
  side: Float32Array
}

/** Grid resolution of the mouth mesh. */
export const MOUTH_GRID = { cols: 24, rows: 16 } as const

/**
 * The grid resolution for a mouth of a given size.
 *
 * The rows have to be fine enough that only a thin sliver of the lip is
 * stretched when the jaw drops: the edge of the opening is a hard line in the
 * texture, and a coarse grid smears it over the whole opening.
 */
export function mouthGridFor(rect: Rect): { cols: number; rows: number } {
  return {
    cols: clamp(Math.round(rect.w / 3.2), 20, 56),
    rows: clamp(Math.round(rect.h / 1.4), 20, 64),
  }
}

/** How far the upper lip travels at full openness, relative to the mouth height. */
export const LIFT_GAIN = 0.26
/** How far the lower lip travels at full openness. The jaw drops more than the upper lip lifts. */
export const DROP_GAIN = 0.32
/** Extra lift of the upper lip when the teeth should show. */
const TEETH_GAIN = 0.12
/** Horizontal spread of the corners at width = 1, relative to the mouth width. */
const WIDTH_GAIN = 0.3
/** Horizontal pull of the corners at roundness = 1. */
const ROUND_GAIN = 0.22
/**
 * How much the whole mouth contracts at roundness = 1, relative to its width.
 * Moving the corners alone would only squash the ends of the mouth, the
 * contraction is what makes the lips pucker.
 */
const ROUND_CONTRACT = 0.07
/** Peak weight of the corner field. Kept below 1 so that the corner does not
 *  swallow the vertical motion of the lips. */
const CORNER_PEAK = 0.45
/** Radius of the corner field, relative to the mouth width. */
const CORNER_RADIUS = 0.26
/**
 * How far the blend band reaches beyond the opening, relative to the height of
 * the mouth. The band is what makes the edge of the aperture lag behind the
 * lip, so the teeth underneath become visible when the mouth opens.
 */
const BAND_EXTRA = 0.06

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function smoothstep01(value: number): number {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * A parabola through three points, used for the lip curves.
 *
 * The lips are not straight lines: the upper lip has a cupid's bow and the
 * seam between the lips curves down towards the corners. A quadratic through
 * the corners and the mid point is close enough to place the weights and
 * costs nothing at runtime.
 */
function parabola(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) {
  const d0 = (x0 - x1) * (x0 - x2)
  const d1 = (x1 - x0) * (x1 - x2)
  const d2 = (x2 - x0) * (x2 - x1)
  if (Math.abs(d0) < 1e-6 || Math.abs(d1) < 1e-6 || Math.abs(d2) < 1e-6) {
    // Degenerate control points (a corner sits on the mid point): fall back to
    // a straight line so the curve stays finite.
    return (x: number) => {
      const t = (x - x1) / (x2 - x1 || 1)
      return y1 + (y2 - y1) * t
    }
  }
  return (x: number) => {
    const l0 = ((x - x1) * (x - x2)) / d0
    const l1 = ((x - x0) * (x - x2)) / d1
    const l2 = ((x - x0) * (x - x1)) / d2
    return y0 * l0 + y1 * l1 + y2 * l2
  }
}

/**
 * The curves of the mouth.
 *
 * `innerTop` / `innerBottom` describe the edge of the opening, `outerTop` the
 * top edge of the upper lip. They are used to place the weights and to paint
 * the cavity, so both always agree on where the lips are.
 */
export interface MouthCurves {
  innerTop: (x: number) => number
  innerBottom: (x: number) => number
  outerTop: (x: number) => number
  outerBottom: (x: number) => number
}

/** Builds the lip curves of a mouth from its control points. */
export function mouthCurves(control: MouthControl): MouthCurves {
  return {
    innerTop: parabola(
      control.cornerL.x,
      control.cornerL.y,
      control.innerUpper.x,
      control.innerUpper.y,
      control.cornerR.x,
      control.cornerR.y,
    ),
    innerBottom: parabola(
      control.cornerL.x,
      control.cornerL.y,
      control.innerLower.x,
      control.innerLower.y,
      control.cornerR.x,
      control.cornerR.y,
    ),
    outerTop: parabola(
      control.cornerL.x,
      control.cornerL.y,
      control.upper.x,
      control.upper.y,
      control.cornerR.x,
      control.cornerR.y,
    ),
    outerBottom: parabola(
      control.cornerL.x,
      control.cornerL.y,
      control.lower.x,
      control.lower.y,
      control.cornerR.x,
      control.cornerR.y,
    ),
  }
}

/**
 * Moves every vertex of the mouth mesh according to the current mouth shape.
 *
 * The displacement of a vertex is the weighted average of the three motion
 * fields (upper lip, lower lip, corners), normalised by the total weight.
 * Because the weights form a partition of the mouth area, neighbouring
 * vertices always end up next to each other and the mouth never tears.
 */
export function deformMouthPositions(
  base: Float32Array,
  weights: MouthWeights,
  control: MouthControl,
  shape: MouthShape,
  out: Float32Array,
): void {
  const count = Math.min(base.length, out.length) >> 1
  const openness = clamp(shape.openness, 0, 1)
  const width = clamp(shape.width, -1, 1)
  const roundness = clamp(shape.roundness, 0, 1)
  const teeth = clamp(shape.teeth, 0, 1)

  const mouthHeight = Math.max(1, control.lower.y - control.upper.y)
  const mouthWidth = Math.max(1, control.cornerR.x - control.cornerL.x)

  // Everything scales with the size of the mouth, so the same numbers work
  // for a thumbnail and for a 4K portrait.
  const lift = openness * mouthHeight * LIFT_GAIN
  const drop = openness * mouthHeight * DROP_GAIN
  const teethLift = openness * teeth * mouthHeight * TEETH_GAIN
  const spread = width * mouthWidth * WIDTH_GAIN
  const purse = roundness * mouthWidth * ROUND_GAIN

  const upperDy = -(lift + teethLift)
  const lowerDy = drop
  // Pouting pulls the whole mouth towards its centre. This is a scale about
  // the centre, not a distance: multiplying a length by the distance from the
  // centre would move the outer vertices by several times the mouth width and
  // smear the lips across the face.
  const contractScale = 1 - roundness * ROUND_CONTRACT
  const centerX = (control.cornerL.x + control.cornerR.x) / 2

  for (let i = 0; i < count; i += 1) {
    const aUpper = weights.upper[i]
    const aLower = weights.lower[i]
    const aCorner = weights.corner[i]
    const side = weights.side[i]
    // The +1e-6 keeps the division finite for vertices that are not part of
    // the mouth at all; their numerator is zero, so they stay put.
    const total = aUpper + aLower + aCorner + 1e-6
    const cornerDx = side * (spread - purse)
    // The lips contract towards the middle of the mouth when they are
    // rounded; the corners alone would only move the two ends.
    const dx =
      (aCorner * cornerDx) / total +
      (base[i * 2] - centerX) * (contractScale - 1) * (aUpper + aLower)
    const dy = (aUpper * upperDy + aLower * lowerDy) / total
    out[i * 2] = base[i * 2] + dx
    out[i * 2 + 1] = base[i * 2 + 1] + dy
  }
}

export interface MouthFieldOptions {
  /** The area the grid covers, in character coordinates. */
  rect: Rect
  cols: number
  rows: number
  control: MouthControl
}

export interface MouthField {
  /** The resting positions of the grid vertices. */
  base: Float32Array
  weights: MouthWeights
}

/**
 * Builds the deformation field for a mouth area.
 *
 * The grid is laid out over `rect` in character coordinates, the same space
 * the layer offsets use, so the weights can be computed once at import time
 * and reused for every frame.
 */
export function buildMouthField(options: MouthFieldOptions): MouthField {
  const { rect, control } = options
  const cols = Math.max(2, Math.round(options.cols))
  const rows = Math.max(2, Math.round(options.rows))
  const count = cols * rows

  const base = new Float32Array(count * 2)
  const upper = new Float32Array(count)
  const lower = new Float32Array(count)
  const corner = new Float32Array(count)
  const side = new Float32Array(count)

  const centerX = (control.cornerL.x + control.cornerR.x) / 2
  const halfWidth = Math.max(1, (control.cornerR.x - control.cornerL.x) / 2)

  // The inner lips bound the opening. Both curves run through the corners,
  // where the two lips meet.
  const curves = mouthCurves(control)
  const innerTop = curves.innerTop
  const innerBottom = curves.innerBottom
  const cornerRadius = Math.max(4, halfWidth * 2 * CORNER_RADIUS)
  // The blend band around the opening. It is a little wider than the opening
  // itself so that the edge of the aperture lags behind the lip that covers
  // it; that lag is what uncovers the teeth.
  const bandExtra = Math.max(1, (control.lower.y - control.upper.y) * BAND_EXTRA)

  for (let j = 0; j < rows; j += 1) {
    const v = rows === 1 ? 0 : j / (rows - 1)
    const y = rect.y + v * rect.h
    for (let i = 0; i < cols; i += 1) {
      const u = cols === 1 ? 0 : i / (cols - 1)
      const x = rect.x + u * rect.w
      const index = j * cols + i
      base[index * 2] = x
      base[index * 2 + 1] = y

      const top = innerTop(x) - bandExtra
      const bottom = innerBottom(x) + bandExtra
      // Inside the band the upper and the lower field blend, which is what
      // makes the opening grow when the jaw drops.
      let upperWeight: number
      if (y <= top) upperWeight = 1
      else if (y >= bottom) upperWeight = 0
      else {
        const t = bottom - top < 1e-6 ? 0 : (y - top) / (bottom - top)
        upperWeight = 1 - smoothstep01(t)
      }
      upper[index] = upperWeight
      lower[index] = 1 - upperWeight

      const dLeft = Math.hypot(x - control.cornerL.x, y - control.cornerL.y)
      const dRight = Math.hypot(x - control.cornerR.x, y - control.cornerR.y)
      const d = Math.min(dLeft, dRight)
      corner[index] = CORNER_PEAK * smoothstep01(1 - d / cornerRadius)

      side[index] = clamp((x - centerX) / halfWidth, -1, 1)
    }
  }

  return { base, weights: { upper, lower, corner, side } }
}

/** The control points of a face geometry, ready for the deform field. */
export function controlFromGeometry(geometry: {
  mouthUpperMid: Point
  mouthLowerMid: Point
  mouthCornerL: Point
  mouthCornerR: Point
  mouthInnerUpperMid: Point
  mouthInnerLowerMid: Point
}): MouthControl {
  return {
    upper: geometry.mouthUpperMid,
    lower: geometry.mouthLowerMid,
    cornerL: geometry.mouthCornerL,
    cornerR: geometry.mouthCornerR,
    innerUpper: geometry.mouthInnerUpperMid,
    innerLower: geometry.mouthInnerLowerMid,
  }
}
