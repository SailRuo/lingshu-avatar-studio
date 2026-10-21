import { Texture } from 'pixi.js'
import type { LayerDef } from '../../types/character'

interface CanvasPair {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

function makeCanvas(width: number, height: number): CanvasPair {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D unavailable')
  return { canvas, ctx }
}

function luminance(r: number, g: number, b: number): number {
  return r * 0.299 + g * 0.587 + b * 0.114
}

function chroma(r: number, g: number, b: number): number {
  return Math.max(r, g, b) - Math.min(r, g, b)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  def: LayerDef,
  originX: number,
  originY: number,
  shiftY = 0,
): void {
  ctx.drawImage(
    image,
    def.offset.x - originX,
    def.offset.y - originY + shiftY,
    def.size.w,
    def.size.h,
  )
}

/**
 * Builds a closed-eye patch from the head pixels around the eye. The eye
 * opening is repainted with real cheek skin and a lash line, so the open eye
 * baked into the head layer is actually covered while blinking.
 */
export function createClosedEyeTexture(
  eyeImage: HTMLImageElement,
  headImage: HTMLImageElement,
  eyeDef: LayerDef,
  headDef: LayerDef,
): { texture: Texture; pad: number } | null {
  const ew = Math.round(eyeDef.size.w)
  const eh = Math.round(eyeDef.size.h)
  if (ew < 8 || eh < 6) return null
  const pad = Math.max(3, Math.round(eh * 0.16))
  const w = ew + pad * 2
  const h = eh + pad * 2
  const originX = eyeDef.offset.x - pad
  const originY = eyeDef.offset.y - pad

  const patch = makeCanvas(w, h)
  drawLayer(patch.ctx, headImage, headDef, originX, originY)
  const base = patch.ctx.getImageData(0, 0, w, h)

  const eyeCanvas = makeCanvas(ew, eh)
  eyeCanvas.ctx.drawImage(eyeImage, 0, 0, ew, eh)
  const eyeData = eyeCanvas.ctx.getImageData(0, 0, ew, eh)

  // The eye layer is feathered around the whole eye socket. Repainting that
  // entire feathered area is what removes the open eye baked into the head.
  const maskCanvas = makeCanvas(w, h)
  maskCanvas.ctx.filter = 'blur(1.2px)'
  for (const [dx, dy] of [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    maskCanvas.ctx.drawImage(eyeImage, pad + dx, pad + dy, ew, eh)
  }
  maskCanvas.ctx.filter = 'none'
  // Expand over the whole eye opening, not just the feathered eye texture.
  maskCanvas.ctx.save()
  maskCanvas.ctx.filter = 'blur(2px)'
  maskCanvas.ctx.fillStyle = '#ffffff'
  maskCanvas.ctx.beginPath()
  maskCanvas.ctx.ellipse(pad + ew / 2, pad + eh / 2, ew * 0.53, eh * 0.54, 0, 0, Math.PI * 2)
  maskCanvas.ctx.fill()
  maskCanvas.ctx.restore()
  const mask = maskCanvas.ctx.getImageData(0, 0, w, h).data

  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  let darkMinX = w
  let darkMaxX = 0
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const alpha = mask[(y * w + x) * 4 + 3]
      if (alpha > 20) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  for (let y = 0; y < eh; y += 1) {
    for (let x = 0; x < ew; x += 1) {
      const i = (y * ew + x) * 4
      if (eyeData.data[i + 3] < 120) continue
      if (luminance(eyeData.data[i], eyeData.data[i + 1], eyeData.data[i + 2]) > 105) continue
      if (x < darkMinX) darkMinX = x
      if (x > darkMaxX) darkMaxX = x
    }
  }
  if (maxX <= minX || maxY <= minY) return null

  const skin = sampleSkin(base.data, w, h)
  const fillCanvas = makeCanvas(w, h)
  fillCanvas.ctx.filter = 'blur(2.2px)'
  drawLayer(fillCanvas.ctx, headImage, headDef, originX, originY, -eh * 0.95)
  fillCanvas.ctx.filter = 'none'
  const fill = fillCanvas.ctx.getImageData(0, 0, w, h).data

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4
      const raw = mask[i + 3]
      if (raw <= 6) continue
      const coverage = smoothstep(raw / 200)
      const fr = fill[i]
      const fg = fill[i + 1]
      const fb = fill[i + 2]
      const fa = fill[i + 3]
      const fLum = luminance(fr, fg, fb)
      const usable = fa > 160 && fLum > 110 && chroma(fr, fg, fb) < 105
      const shade = 0.97 + (y / h) * 0.05
      const nr = usable ? (fr * 0.72 + skin.r * 0.28) * shade : skin.r * shade
      const ng = usable ? (fg * 0.72 + skin.g * 0.28) * shade : skin.g * shade
      const nb = usable ? (fb * 0.72 + skin.b * 0.28) * shade : skin.b * shade
      base.data[i] = base.data[i] * (1 - coverage) + clamp(nr, 0, 255) * coverage
      base.data[i + 1] = base.data[i + 1] * (1 - coverage) + clamp(ng, 0, 255) * coverage
      base.data[i + 2] = base.data[i + 2] * (1 - coverage) + clamp(nb, 0, 255) * coverage
    }
  }
  patch.ctx.putImageData(base, 0, 0)

  const eyeSpanLeft = darkMaxX > darkMinX ? pad + darkMinX - 1 : minX + (maxX - minX) * 0.06
  const eyeSpanRight = darkMaxX > darkMinX ? pad + darkMaxX + 1 : maxX - (maxX - minX) * 0.06
  const eyeW = Math.max(8, eyeSpanRight - eyeSpanLeft)
  const eyeH = Math.max(5, maxY - minY)
  const cornerY = minY + eyeH * 0.58
  const centerY = minY + eyeH * 0.78
  const centerX = (eyeSpanLeft + eyeSpanRight) / 2
  const lash = sampleLashColor(eyeImage)

  patch.ctx.save()
  patch.ctx.filter = 'blur(2.4px)'
  patch.ctx.strokeStyle = 'rgba(86, 54, 38, 0.14)'
  patch.ctx.lineWidth = Math.max(3, eyeH * 0.16)
  patch.ctx.beginPath()
  patch.ctx.moveTo(eyeSpanLeft, cornerY - eyeH * 0.06)
  patch.ctx.quadraticCurveTo(centerX, centerY - eyeH * 0.04, eyeSpanRight, cornerY - eyeH * 0.06)
  patch.ctx.stroke()
  patch.ctx.restore()

  patch.ctx.save()
  patch.ctx.strokeStyle = `rgba(${lash.r}, ${lash.g}, ${lash.b}, 0.92)`
  patch.ctx.lineWidth = Math.max(1.2, eyeH * 0.085)
  patch.ctx.lineCap = 'round'
  patch.ctx.beginPath()
  patch.ctx.moveTo(eyeSpanLeft, cornerY)
  patch.ctx.quadraticCurveTo(centerX, centerY, eyeSpanRight, cornerY)
  patch.ctx.stroke()

  // Slight lash flicks at both corners.
  patch.ctx.lineWidth = Math.max(0.8, eyeH * 0.045)
  patch.ctx.beginPath()
  patch.ctx.moveTo(eyeSpanLeft, cornerY)
  patch.ctx.lineTo(eyeSpanLeft - eyeW * 0.025, cornerY - eyeH * 0.03)
  patch.ctx.moveTo(eyeSpanRight, cornerY)
  patch.ctx.lineTo(eyeSpanRight + eyeW * 0.025, cornerY - eyeH * 0.03)
  patch.ctx.stroke()
  patch.ctx.restore()

  // A soft crease above the lid helps the eye read as closed rather than painted.
  patch.ctx.save()
  patch.ctx.filter = 'blur(1.2px)'
  patch.ctx.strokeStyle = 'rgba(120, 76, 52, 0.16)'
  patch.ctx.lineWidth = Math.max(0.8, eyeH * 0.035)
  patch.ctx.beginPath()
  patch.ctx.moveTo(eyeSpanLeft + eyeW * 0.08, cornerY - eyeH * 0.16)
  patch.ctx.quadraticCurveTo(centerX, centerY - eyeH * 0.24, eyeSpanRight - eyeW * 0.08, cornerY - eyeH * 0.16)
  patch.ctx.stroke()
  patch.ctx.restore()

  const texture = Texture.from(patch.canvas)
  return { texture, pad }
}

function sampleSkin(data: Uint8ClampedArray, w: number, h: number): { r: number; g: number; b: number } {
  const samples: Array<{ r: number; g: number; b: number; lum: number }> = []
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4
      if (data[i + 3] < 180) continue
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const lum = luminance(r, g, b)
      if (lum < 140 || lum > 252) continue
      if (chroma(r, g, b) > 92) continue
      samples.push({ r, g, b, lum })
    }
  }
  if (!samples.length) return { r: 225, g: 190, b: 160 }
  samples.sort((a, b) => a.lum - b.lum)
  const start = Math.floor(samples.length * 0.45)
  const selected = samples.slice(start)
  let r = 0
  let g = 0
  let b = 0
  for (const sample of selected) {
    r += sample.r
    g += sample.g
    b += sample.b
  }
  return {
    r: r / selected.length,
    g: g / selected.length,
    b: b / selected.length,
  }
}

function sampleLashColor(image: HTMLImageElement): { r: number; g: number; b: number } {
  const w = Math.max(1, image.naturalWidth || image.width)
  const h = Math.max(1, image.naturalHeight || image.height)
  const { ctx } = makeCanvas(w, h)
  ctx.drawImage(image, 0, 0)
  try {
    const data = ctx.getImageData(0, 0, w, h).data
    let r = 0
    let g = 0
    let b = 0
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 100) continue
      const lum = luminance(data[i], data[i + 1], data[i + 2])
      if (lum > 85) continue
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
      count += 1
    }
    if (count > 0) {
      return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) }
    }
  } catch {
    // Blob-backed images are same-origin; fall back to a natural lash tone.
  }
  return { r: 44, g: 28, b: 22 }
}

interface MouthVariant {
  texture: Texture
}

function drawOpening(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  openness: number,
): void {
  const cx = width / 2
  const cy = height * 0.47
  const rx = width * 0.27
  const ry = height * openness
  const top = cy - ry
  const bottom = cy + ry

  ctx.save()
  ctx.beginPath()
  ctx.ellipse(cx, cy + ry * 0.25, rx, ry, 0, 0, Math.PI * 2)
  const gradient = ctx.createLinearGradient(0, top, 0, bottom + ry * 0.5)
  gradient.addColorStop(0, '#241011')
  gradient.addColorStop(0.48, '#3a171a')
  gradient.addColorStop(0.76, '#63272c')
  gradient.addColorStop(1, '#2b1114')
  ctx.fillStyle = gradient
  ctx.fill()

  ctx.clip()
  const teethHeight = Math.max(1.4, ry * 0.4)
  ctx.fillStyle = 'rgba(248, 238, 224, 0.94)'
  ctx.beginPath()
  ctx.ellipse(cx, top + ry * 0.34, rx * 0.8, teethHeight, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(181, 74, 82, 0.92)'
  ctx.beginPath()
  ctx.ellipse(cx, bottom + ry * 0.02, rx * 0.72, ry * 0.52, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.strokeStyle = 'rgba(32, 12, 12, 0.62)'
  ctx.lineWidth = Math.max(0.9, ry * 0.06)
  ctx.beginPath()
  ctx.ellipse(cx, cy + ry * 0.25, rx, ry, 0, 0, Math.PI * 2)
  ctx.stroke()

  // Lower lip and corner shadows give the opening some depth.
  ctx.filter = 'blur(1.2px)'
  ctx.strokeStyle = 'rgba(92, 38, 33, 0.28)'
  ctx.lineWidth = Math.max(1, ry * 0.1)
  ctx.beginPath()
  ctx.moveTo(cx - rx * 0.82, cy + ry * 1.12)
  ctx.quadraticCurveTo(cx, cy + ry * 1.32, cx + rx * 0.82, cy + ry * 1.12)
  ctx.stroke()
  ctx.restore()
}

function drawSmile(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  skin: { r: number; g: number; b: number },
): void {
  // Remove the original closed lips completely before drawing a new smile.
  ctx.save()
  ctx.filter = 'blur(2.6px)'
  ctx.fillStyle = `rgb(${Math.round(skin.r)}, ${Math.round(skin.g)}, ${Math.round(skin.b)})`
  ctx.beginPath()
  ctx.ellipse(width / 2, height * 0.48, width * 0.43, height * 0.16, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  const left = width * 0.23
  const right = width * 0.77
  const cornerY = height * 0.44
  const upperY = height * 0.53
  const lowerY = height * 0.61
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(left, cornerY)
  ctx.quadraticCurveTo(width / 2, upperY, right, cornerY)
  ctx.quadraticCurveTo(width / 2, lowerY, left, cornerY)
  ctx.closePath()
  ctx.fillStyle = 'rgba(42, 17, 17, 0.94)'
  ctx.fill()
  ctx.clip()
  ctx.fillStyle = 'rgba(249, 239, 226, 0.96)'
  ctx.beginPath()
  ctx.ellipse(width / 2, cornerY + height * 0.028, width * 0.21, height * 0.025, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(181, 75, 82, 0.85)'
  ctx.beginPath()
  ctx.ellipse(width / 2, lowerY - height * 0.008, width * 0.15, height * 0.018, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.strokeStyle = 'rgba(77, 33, 28, 0.82)'
  ctx.lineWidth = Math.max(1.1, height * 0.032)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(left, cornerY)
  ctx.quadraticCurveTo(width / 2, upperY, right, cornerY)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(74, 30, 26, 0.5)'
  ctx.lineWidth = Math.max(0.8, height * 0.022)
  ctx.beginPath()
  ctx.moveTo(left + width * 0.04, cornerY + height * 0.006)
  ctx.quadraticCurveTo(width / 2, lowerY + height * 0.014, right - width * 0.04, cornerY + height * 0.006)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(255, 235, 218, 0.2)'
  ctx.lineWidth = Math.max(0.8, height * 0.016)
  ctx.beginPath()
  ctx.moveTo(width * 0.3, height * 0.66)
  ctx.quadraticCurveTo(width / 2, height * 0.7, width * 0.7, height * 0.66)
  ctx.stroke()
  ctx.restore()
}

/** Rounded lips: a small circular opening used for /u/ and /o/-like sounds. */
function drawRoundOpening(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const cx = width / 2
  const cy = height * 0.47
  const rx = Math.min(width * 0.16, height * 0.2)
  const ry = height * 0.2

  ctx.save()
  ctx.beginPath()
  ctx.ellipse(cx, cy + ry * 0.2, rx, ry, 0, 0, Math.PI * 2)
  const gradient = ctx.createLinearGradient(0, cy - ry, 0, cy + ry * 1.4)
  gradient.addColorStop(0, '#2b1214')
  gradient.addColorStop(0.52, '#4a1c20')
  gradient.addColorStop(1, '#631f26')
  ctx.fillStyle = gradient
  ctx.fill()
  ctx.strokeStyle = 'rgba(32, 12, 12, 0.62)'
  ctx.lineWidth = Math.max(0.9, ry * 0.09)
  ctx.stroke()
  ctx.restore()
}

/** Sibilants: a thin slit with the upper teeth showing through it. */
function drawTeethSlit(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const cx = width / 2
  const cy = height * 0.47
  const rx = width * 0.3
  const ry = Math.max(1.2, height * 0.05)

  ctx.save()
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.fillStyle = '#331417'
  ctx.fill()
  ctx.clip()
  ctx.fillStyle = 'rgba(248, 238, 224, 0.95)'
  ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 1.05)
  ctx.restore()

  ctx.save()
  ctx.strokeStyle = 'rgba(32, 12, 12, 0.5)'
  ctx.lineWidth = 0.9
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

export interface MouthVariantSet {
  half: MouthVariant
  open: MouthVariant
  smile: MouthVariant
  round: MouthVariant
  teeth: MouthVariant
}

export function createMouthVariantTextures(
  mouthImage: HTMLImageElement,
  mouthDef: LayerDef,
): MouthVariantSet | null {
  const w = Math.max(8, Math.round(mouthDef.size.w))
  const h = Math.max(8, Math.round(mouthDef.size.h))
  if (w < 8 || h < 8) return null

  const base = makeCanvas(w, h)
  base.ctx.drawImage(mouthImage, 0, 0, w, h)
  const baseData = base.ctx.getImageData(0, 0, w, h)

  let skinR = 0
  let skinG = 0
  let skinB = 0
  let skinCount = 0
  for (const [x, y] of [
    [w * 0.12, h * 0.2],
    [w * 0.88, h * 0.2],
    [w * 0.5, h * 0.86],
    [w * 0.72, h * 0.82],
  ]) {
    const i = (Math.round(y) * w + Math.round(x)) * 4
    if (baseData.data[i + 3] < 128) continue
    skinR += baseData.data[i]
    skinG += baseData.data[i + 1]
    skinB += baseData.data[i + 2]
    skinCount += 1
  }
  if (!skinCount) {
    skinR = 226
    skinG = 192
    skinB = 162
    skinCount = 1
  }
  const skin = { r: skinR / skinCount, g: skinG / skinCount, b: skinB / skinCount }

  const build = (openness: number): Texture => {
    const { canvas, ctx } = makeCanvas(w, h)
    ctx.drawImage(mouthImage, 0, 0, w, h)
    drawOpening(ctx, w, h, openness)
    return Texture.from(canvas)
  }

  const smileCanvas = makeCanvas(w, h)
  smileCanvas.ctx.drawImage(mouthImage, 0, 0, w, h)
  drawSmile(smileCanvas.ctx, w, h, skin)

  const roundCanvas = makeCanvas(w, h)
  roundCanvas.ctx.drawImage(mouthImage, 0, 0, w, h)
  drawRoundOpening(roundCanvas.ctx, w, h)

  const teethCanvas = makeCanvas(w, h)
  teethCanvas.ctx.drawImage(mouthImage, 0, 0, w, h)
  drawTeethSlit(teethCanvas.ctx, w, h)

  return {
    half: { texture: build(0.14) },
    open: { texture: build(0.3) },
    smile: { texture: Texture.from(smileCanvas.canvas) },
    round: { texture: Texture.from(roundCanvas.canvas) },
    teeth: { texture: Texture.from(teethCanvas.canvas) },
  }
}
