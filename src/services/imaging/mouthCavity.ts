/**
 * The cavity behind the lips.
 *
 * When the mouth opens, the lips have to reveal something: the inside of the
 * mouth. That is what this layer is — a fixed picture of the cavity with a row
 * of upper teeth, a tongue and a shaded palate. The lips slide over it; only
 * the mouth mesh deforms.
 */

import type { Point, Rect } from '../../types/character'
import type { Mask } from '../cv/masks'
import { createMask, maskFromCanvas, maskToCanvas, polygonArea } from '../cv/masks'
import { DROP_GAIN, LIFT_GAIN, type MouthControl } from '../render/mouthDeform'

export interface MouthCavityOptions {
  /** The original picture, used to sample a plausible tooth colour. */
  source: HTMLCanvasElement
  /** The area of the mouth inside the character canvas. */
  mask: Mask
  /** The bounding box of the cavity texture. */
  box: Rect
  control: MouthControl
  /**
   * Paint the upper teeth into the cavity. Defaults to on: a cavity without
   * teeth reads as a black hole. Pass `false` only for a reference cut.
   */
  drawTeeth?: boolean
  /**
   * A full-canvas picture of the same character with the mouth slightly open.
   * When present the cavity is cut from those real pixels instead of being
   * painted, which is the only way to get truly photographic teeth and tongue
   * shading.
   */
  reference?: HTMLCanvasElement
}

/** Height of the tooth band, relative to the visible cavity window. */
const TEETH_BAND = 0.26

/**
 * The resting aperture is a lens, not a zero-height line. Its half-height is
 * part of the window that opens up, so the cavity mask has to include it on
 * top of the lip travel.
 */
/** How much of each end of the cavity fades out, to keep corners clean. */
const END_FADE_RATIO = 0.14

export const MOUTH_APERTURE_WIDTH = 0.38
export const MOUTH_APERTURE_HEIGHT = 0.12

/** Soft edge of the painted cavity, in texture pixels. */
const CAVITY_FEATHER_PX = 0.8

/**
 * Soft edge of the hole punched through the lips. A one-pixel cut makes the
 * dark interior meet the lip colour as a hard vector edge; a couple of pixels
 * lets the two blend the way a painted lip does.
 */
const APERTURE_FEATHER_PX = 0.8

/** Whether a point lies inside a polygon (even-odd rule). */
function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]
    const b = polygon[j]
    if (a.y > point.y !== b.y > point.y) {
      const t = (point.y - a.y) / (b.y - a.y)
      if (point.x < a.x + t * (b.x - a.x)) inside = !inside
    }
  }
  return inside
}

/**
 * Checks that the inner lip ring can be used to open the mouth.
 *
 * The landmarker sometimes returns an inner ring that collapsed onto the
 * outer one, or that came back inside out. Cutting the opening along such a
 * ring would tear a hole into the lips, so the character falls back to the
 * plain mouth textures instead.
 */
export function isUsableInnerLip(geometry: { lipInner: Point[]; mouth: Point[] }): boolean {
  const inner = geometry.lipInner
  const outer = geometry.mouth
  if (inner.length < 6 || outer.length < 6) return false
  const outerArea = polygonArea(outer)
  if (outerArea <= 1) return false
  const innerArea = polygonArea(inner)
  if (innerArea <= 0 || innerArea >= outerArea * 0.92) return false
  let cx = 0
  let cy = 0
  for (const point of inner) {
    cx += point.x
    cy += point.y
  }
  cx /= inner.length
  cy /= inner.length
  return pointInPolygon({ x: cx, y: cy }, outer)
}

/**
 * The area the cavity has to cover.
 *
 * The aperture in the lips is the natural opening, and for a closed mouth that
 * is a two-pixel sliver. A cavity of the same size can only be stretched into
 * a blur when the jaw drops. The cavity therefore covers the whole area the
 * opening can reach at full openness, so separating the lips reveals a real
 * interior instead of smearing a sliver.
 */
export function cavityOvalMask(
  width: number,
  height: number,
  control: MouthControl,
  box: Rect,
): Mask {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(box.w))
  canvas.height = Math.max(1, Math.round(box.h))
  const ctx = canvas.getContext('2d')
  if (!ctx) return createMask(width, height)
  const mouthHeight = Math.max(1, control.lower.y - control.upper.y)
  const halfWidth = Math.max(1, (control.cornerR.x - control.cornerL.x) / 2)
  const cx = (control.cornerL.x + control.cornerR.x) / 2 - box.x
  // The visible window is exactly the area between the upper lip at full lift
  // and the lower lip at full drop. Matching that window (instead of using a
  // tall oval that extends under both lips) is what keeps the teeth and
  // tongue inside the opening. The gain constants come from the deformation
  // field so the two can never drift apart.
  const lift = mouthHeight * LIFT_GAIN
  const drop = mouthHeight * DROP_GAIN
  // The opening starts as a lens with a non-zero height. Its half-height is
  // part of the window too; leaving it out clips the teeth against the top
  // edge of the cavity.
  const apertureHalfHeight = mouthHeight * MOUTH_APERTURE_HEIGHT
  const halfH = Math.max(1, (lift + drop) / 2 + apertureHalfHeight)
  const cy =
    (control.innerUpper.y + control.innerLower.y) / 2 + (drop - lift) / 2 - box.y
  const angle = Math.atan2(
    control.cornerR.y - control.cornerL.y,
    control.cornerR.x - control.cornerL.x,
  )
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.ellipse(cx, cy, halfWidth * 0.76, halfH, angle, 0, Math.PI * 2)
  ctx.fill()
  const oval = maskFromCanvas(canvas)
  const out = createMask(width, height)
  const ox = Math.round(box.x)
  const oy = Math.round(box.y)
  for (let y = 0; y < oval.height; y += 1) {
    const ty = y + oy
    if (ty < 0 || ty >= height) continue
    for (let x = 0; x < oval.width; x += 1) {
      const tx = x + ox
      if (tx < 0 || tx >= width) continue
      out.data[ty * width + tx] = oval.data[y * oval.width + x]
    }
  }
  return out
}

/**
 * Cuts the opening out of the mouth layer.
 *
 * The mouth texture keeps the lips; the hole in the middle is where the
 * cavity shows through when the jaw drops. The hole reaches a little beyond
 * the inner lip line, so that the line between the lips is removed as a
 * whole: what is left at the edge of the hole is plain skin, and plain skin
 * that gets stretched does not look like a smear.
 */
export function punchMouthAperture(
  layer: HTMLCanvasElement,
  aperture: Mask,
  box: Rect,
): void {
  const ctx = layer.getContext('2d')
  if (!ctx) return
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.drawImage(maskToCanvas(aperture, box, APERTURE_FEATHER_PX), 0, 0)
  ctx.restore()
}

/**
 * Softens the dark pixels at the extreme mouth corners.
 *
 * The mouth mesh pulls the corners apart when the jaw drops. A hard black
 * corner dot in the lip texture gets stretched into a vertical spike at that
 * moment. Making only the darkest corner pixels translucent lets the head
 * layer's original, undeformed corner show through, so the closed mouth keeps
 * its line while the open mouth stops sprouting fangs.
 */
export function softenMouthCorners(
  layer: HTMLCanvasElement,
  control: MouthControl,
  box: Rect,
): void {
  const ctx = layer.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  const width = layer.width
  const height = layer.height
  const image = ctx.getImageData(0, 0, width, height)
  const data = image.data
  const rx = Math.max(8, (control.cornerR.x - control.cornerL.x) * 0.13)
  const ry = Math.max(7, (control.lower.y - control.upper.y) * 0.35)
  const corners = [
    { x: control.cornerL.x - box.x, y: control.cornerL.y - box.y },
    { x: control.cornerR.x - box.x, y: control.cornerR.y - box.y },
  ]
  for (const corner of corners) {
    const x0 = Math.max(0, Math.floor(corner.x - rx))
    const x1 = Math.min(width - 1, Math.ceil(corner.x + rx))
    const y0 = Math.max(0, Math.floor(corner.y - ry))
    const y1 = Math.min(height - 1, Math.ceil(corner.y + ry))
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = (x - corner.x) / rx
        const dy = (y - corner.y) / ry
        const distance = dx * dx + dy * dy
        if (distance >= 1) continue
        const i = (y * width + x) * 4
        if (data[i + 3] === 0) continue
        // Fade everything near the corner, whatever its brightness. Keeping
        // bright pixels was wrong: the bright thing at a mouth corner is skin,
        // and the deformation drags it out into a pale blob beside the lips.
        // The head layer already holds the original corner, so nothing has to
        // survive here.
        const fade = 1 - distance
        data[i + 3] = Math.round(data[i + 3] * fade)
      }
    }
  }
  ctx.putImageData(image, 0, 0)
}

/**
 * Paints a stylised but readable mouth interior.
 *
 * The cavity is a fixed picture: the lips slide over it, so its features have
 * to be laid out for the opening at full openness. Teeth are placed against
 * the lifted upper lip, the tongue rises from the lower lip, and the palate
 * stays in shadow. Everything is deliberately soft-edged; a crisp vector
 * shape at this size reads as a hole rather than as anatomy.
 */
function paintCavityInterior(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cx: number,
  cy: number,
  mouthWidth: number,
  mouthHeight: number,
  drawTeeth: boolean,
): void {
  // The only part of the texture that can ever be seen is the window between
  // the fully lifted upper lip and the fully dropped lower lip. Lay the whole
  // composition out inside that window, not across the much taller texture.
  const lift = mouthHeight * LIFT_GAIN
  const drop = mouthHeight * DROP_GAIN
  const apertureHalfHeight = mouthHeight * MOUTH_APERTURE_HEIGHT
  const windowHeight = lift + drop + apertureHalfHeight * 2
  const windowCenter = cy + (drop - lift) / 2
  const windowTop = windowCenter - windowHeight / 2
  const windowBottom = windowCenter + windowHeight / 2

  const top = windowTop - mouthHeight * 0.06
  const bottom = windowBottom + mouthHeight * 0.06
  const base = ctx.createLinearGradient(0, top, 0, bottom)
  base.addColorStop(0, '#1c090d')
  base.addColorStop(0.22, '#2a0f12')
  base.addColorStop(0.5, '#3a1218')
  base.addColorStop(0.68, '#5a2025')
  base.addColorStop(0.82, '#7a3235')
  base.addColorStop(1, '#6a272d')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, width, height)

  // The middle of the window is the roof / back of the mouth: the deepest
  // area, but still a warm burgundy rather than flat black.
  const palate = ctx.createRadialGradient(
    cx,
    windowTop + windowHeight * 0.42,
    0,
    cx,
    windowTop + windowHeight * 0.42,
    mouthWidth * 0.52,
  )
  palate.addColorStop(0, 'rgba(12, 3, 7, 0.42)')
  palate.addColorStop(0.55, 'rgba(22, 6, 11, 0.18)')
  palate.addColorStop(1, 'rgba(22, 6, 11, 0)')
  ctx.fillStyle = palate
  ctx.fillRect(0, 0, width, height)

  // Corners fall away into shadow, so the opening tapers instead of ending in
  // two hard vertical cuts.
  const sides = ctx.createLinearGradient(cx - mouthWidth * 0.5, 0, cx + mouthWidth * 0.5, 0)
  sides.addColorStop(0, 'rgba(24, 7, 12, 0.35)')
  sides.addColorStop(0.22, 'rgba(24, 7, 12, 0)')
  sides.addColorStop(0.78, 'rgba(24, 7, 12, 0)')
  sides.addColorStop(1, 'rgba(24, 7, 12, 0.35)')
  ctx.fillStyle = sides
  ctx.fillRect(0, 0, width, height)

  // Warm bounce from the tongue / mouth floor.
  const floor = ctx.createRadialGradient(
    cx,
    windowTop + windowHeight * 0.78,
    0,
    cx,
    windowTop + windowHeight * 0.78,
    mouthWidth * 0.46,
  )
  floor.addColorStop(0, 'rgba(185, 84, 70, 0.26)')
  floor.addColorStop(1, 'rgba(185, 84, 70, 0)')
  ctx.fillStyle = floor
  ctx.fillRect(0, 0, width, height)

  // Tongue: a rounded mound rising from the bottom third of the window.
  const tongueWidth = mouthWidth * 0.62
  const tongueTop = windowTop + windowHeight * 0.58
  const tongueBottom = windowBottom + mouthHeight * 0.08
  const tonguePath = new Path2D()
  tonguePath.moveTo(cx - tongueWidth * 0.5, tongueBottom)
  tonguePath.bezierCurveTo(
    cx - tongueWidth * 0.46,
    tongueTop + windowHeight * 0.1,
    cx - tongueWidth * 0.28,
    tongueTop,
    cx,
    tongueTop,
  )
  tonguePath.bezierCurveTo(
    cx + tongueWidth * 0.28,
    tongueTop,
    cx + tongueWidth * 0.46,
    tongueTop + windowHeight * 0.1,
    cx + tongueWidth * 0.5,
    tongueBottom,
  )
  tonguePath.closePath()
  ctx.save()
  ctx.beginPath()
  const tongueFill = ctx.createLinearGradient(0, tongueTop, 0, tongueBottom)
  tongueFill.addColorStop(0, '#dc8175')
  tongueFill.addColorStop(0.42, '#c4575e')
  tongueFill.addColorStop(1, '#a83e4c')
  ctx.fillStyle = tongueFill
  ctx.fill(tonguePath)

  ctx.clip(tonguePath)
  const tongueLight = ctx.createRadialGradient(
    cx - tongueWidth * 0.06,
    tongueTop + windowHeight * 0.02,
    0,
    cx,
    tongueTop + windowHeight * 0.04,
    tongueWidth * 0.48,
  )
  tongueLight.addColorStop(0, 'rgba(255, 212, 185, 0.55)')
  tongueLight.addColorStop(0.55, 'rgba(255, 164, 143, 0.16)')
  tongueLight.addColorStop(1, 'rgba(255, 164, 143, 0)')
  ctx.fillStyle = tongueLight
  ctx.fillRect(cx - tongueWidth, tongueTop - 2, tongueWidth * 2, tongueBottom - tongueTop + 4)

  ctx.strokeStyle = 'rgba(124, 40, 50, 0.18)'
  ctx.lineWidth = Math.max(0.8, windowHeight * 0.035)
  ctx.beginPath()
  ctx.moveTo(cx, tongueTop + windowHeight * 0.05)
  ctx.quadraticCurveTo(
    cx - mouthWidth * 0.015,
    tongueTop + windowHeight * 0.15,
    cx,
    tongueBottom - windowHeight * 0.04,
  )
  ctx.stroke()
  ctx.restore()

  // Soft shadow where the tongue passes into the dark of the mouth.
  ctx.save()
  const backShadow = ctx.createLinearGradient(
    0,
    tongueTop - windowHeight * 0.05,
    0,
    tongueTop + windowHeight * 0.08,
  )
  backShadow.addColorStop(0, 'rgba(55, 13, 19, 0)')
  backShadow.addColorStop(0.55, 'rgba(55, 13, 19, 0.24)')
  backShadow.addColorStop(1, 'rgba(55, 13, 19, 0)')
  ctx.fillStyle = backShadow
  ctx.fillRect(
    cx - tongueWidth * 0.52,
    tongueTop - windowHeight * 0.05,
    tongueWidth * 1.04,
    windowHeight * 0.13,
  )
  ctx.restore()

  if (drawTeeth) {
    paintUpperTeeth(ctx, cx, mouthWidth, windowTop, windowHeight)
  }

  // The inner edge of the lower lip: a soft dark arc at the floor of the
  // window, so the tongue does not bleed into the lip.
  const lowerHalf = mouthWidth * 0.44
  const steps = 28
  const lowerY = (x: number): number => {
    const u = Math.min(1, Math.abs((x - cx) / lowerHalf))
    return windowBottom - windowHeight * (0.035 + 0.05 * u * u)
  }
  ctx.save()
  ctx.lineCap = 'round'
  for (const [lineWidth, alpha] of [
    [3.0, 0.1],
    [0.9, 0.18],
  ] as const) {
    ctx.strokeStyle = `rgba(54, 13, 19, ${alpha})`
    ctx.lineWidth = lineWidth
    ctx.beginPath()
    for (let i = 0; i <= steps; i += 1) {
      const x = cx - lowerHalf + (lowerHalf * 2 * i) / steps
      const y = lowerY(x)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.restore()
}

/** A curved row of upper teeth that follows the lifted inner lip. */
function paintUpperTeeth(
  ctx: CanvasRenderingContext2D,
  cx: number,
  mouthWidth: number,
  windowTop: number,
  windowHeight: number,
): void {
  const halfSpan = mouthWidth * 0.27
  const left = cx - halfSpan
  const right = cx + halfSpan
  const steps = 36
  const topCenter = windowTop + windowHeight * 0.02
  const topEdge = windowTop + windowHeight * 0.12
  const topY = (x: number): number => {
    const u = (x - cx) / halfSpan
    return topCenter + (topEdge - topCenter) * u * u
  }
  const band = (x: number): number => {
    const u = Math.min(1, Math.abs((x - cx) / halfSpan))
    return windowHeight * (TEETH_BAND - 0.04 * u)
  }
  const traceTop = (): void => {
    for (let i = 0; i <= steps; i += 1) {
      const x = left + ((right - left) * i) / steps
      if (i === 0) ctx.moveTo(x, topY(x))
      else ctx.lineTo(x, topY(x))
    }
  }
  const traceBottom = (): void => {
    for (let i = steps; i >= 0; i -= 1) {
      const x = left + ((right - left) * i) / steps
      const u = (x - cx) / halfSpan
      // Six soft lobes: the lower edge of a row of incisors is scalloped, not
      // a ruler-straight strip.
      const scallop = Math.abs(Math.sin(((u + 1) / 2) * Math.PI * 6)) * windowHeight * 0.022
      ctx.lineTo(x, topY(x) + band(x) - scallop)
    }
  }

  ctx.save()
  ctx.beginPath()
  traceTop()
  traceBottom()
  ctx.closePath()
  const fill = ctx.createLinearGradient(left, 0, right, 0)
  fill.addColorStop(0, 'rgba(255, 253, 248, 0)')
  fill.addColorStop(0.1, 'rgba(255, 253, 248, 0.96)')
  fill.addColorStop(0.9, 'rgba(255, 253, 248, 0.96)')
  fill.addColorStop(1, 'rgba(255, 253, 248, 0)')
  ctx.fillStyle = fill
  ctx.fill()

  ctx.save()
  ctx.clip()
  const shade = ctx.createLinearGradient(
    0,
    topY(cx) - 1,
    0,
    topY(cx) + band(cx) + 1,
  )
  shade.addColorStop(0, 'rgba(255, 255, 255, 0.16)')
  shade.addColorStop(0.5, 'rgba(255, 246, 232, 0)')
  shade.addColorStop(1, 'rgba(143, 80, 79, 0.26)')
  ctx.fillStyle = shade
  ctx.fillRect(left, topY(cx) - 2, right - left, band(cx) + 5)

  // Very soft separations, just enough to read as teeth instead of one strip.
  ctx.strokeStyle = 'rgba(132, 78, 76, 0.24)'
  ctx.lineWidth = 0.8
  for (const u of [-0.8, -0.4, 0, 0.4, 0.8]) {
    const x = cx + halfSpan * u
    ctx.beginPath()
    ctx.moveTo(x, topY(x) + 0.8)
    ctx.lineTo(x, topY(x) + band(x) - 0.6)
    ctx.stroke()
  }
  ctx.restore()

  // The top edge is a shadow under the upper lip, the bottom edge a soft
  // transition back into the dark cavity.
  ctx.lineCap = 'round'
  ctx.strokeStyle = 'rgba(42, 10, 15, 0.45)'
  ctx.lineWidth = 0.9
  ctx.beginPath()
  traceTop()
  ctx.stroke()
  ctx.strokeStyle = 'rgba(75, 25, 29, 0.26)'
  ctx.lineWidth = 0.8
  ctx.beginPath()
  traceBottom()
  ctx.stroke()
  ctx.restore()
}

/**
 * Paints the cavity: a dark opening with a band of upper teeth along its top
 * edge.
 *
 * The teeth sit just under the upper lip and are uncovered when it lifts.
 */
export function createMouthCavityCanvas(options: MouthCavityOptions): HTMLCanvasElement {
  const { source, box, control } = options
  const width = Math.max(1, Math.round(box.w))
  const height = Math.max(1, Math.round(box.h))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  if (options.reference) {
    // Real pixels: the reference has the same framing, so the mouth region of
    // it lands on the same spot. The oval mask below trims it to the opening.
    ctx.drawImage(options.reference, -box.x, -box.y)
  } else {
    const mouthHeight = Math.max(1, control.lower.y - control.upper.y)
    const mouthWidth = Math.max(1, control.cornerR.x - control.cornerL.x)
    const cx = (control.cornerL.x + control.cornerR.x) / 2 - box.x
    const cy = (control.innerUpper.y + control.innerLower.y) / 2 - box.y
    paintCavityInterior(
      ctx,
      width,
      height,
      cx,
      cy,
      mouthWidth,
      mouthHeight,
      options.drawTeeth !== false,
    )
  }

  // Clip to the oval opening. This is the only clip the cavity needs: the
  // runtime fades the whole layer out while the mouth is closed, so it cannot
  // show on the skin, and the closed-lip mask would shrink it to a sliver.
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(
    maskToCanvas(
      cavityOvalMask(source.width, source.height, control, box),
      box,
      options.reference ? 1.2 : CAVITY_FEATHER_PX,
    ),
    0,
    0,
  )

  // Fade the two ends horizontally. The oval bounds the cavity, but at its
  // left and right tips the lips are thin and feathered, so a few dark or
  // white pixels slip past the corner and read as specks floating beside the
  // mouth. The head layer holds the real corner, so the cavity does not have
  // to reach it.
  const endFade = END_FADE_RATIO
  const fade = ctx.createLinearGradient(0, 0, width, 0)
  fade.addColorStop(0, 'rgba(0,0,0,0)')
  fade.addColorStop(endFade, 'rgba(0,0,0,1)')
  fade.addColorStop(1 - endFade, 'rgba(0,0,0,1)')
  fade.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = fade
  ctx.fillRect(0, 0, width, height)

  ctx.globalCompositeOperation = 'source-over'
  return canvas
}
