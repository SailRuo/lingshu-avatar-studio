/**
 * Mouth-shape estimation from raw PCM.
 *
 * The stage can only move between a few baked mouth textures, so the audio is
 * reduced to a small set of articulatory parameters: how far the jaw drops,
 * how the lips are spread, how rounded they are and whether the teeth show.
 * They come from the classic cues of vowel production — the first two
 * formants sit in the low band, /i/-like vowels push energy upwards and
 * fricatives move it above 4 kHz.
 */

export type VisemeId = 'rest' | 'wide' | 'round' | 'narrow' | 'teeth'

/**
 * How the mouth is driven.
 *
 * `envelope` only follows the loudness of the audio — the jaw opens with the
 * voice and nothing else. `approx` additionally reads the spectrum and shapes
 * the lips, so rounded and sibilant sounds get their own mouth.
 */
export type VisemeMode = 'envelope' | 'approx'

export interface MouthShape {
  viseme: VisemeId
  /** 0 = lips closed, 1 = jaw fully dropped. */
  openness: number
  /** -1 = pursed lips, +1 = spread lips. */
  width: number
  /** 0 = flat lips, 1 = rounded lips. */
  roundness: number
  /** 0 = lips closed, 1 = teeth showing. */
  teeth: number
  /** Raw loudness of the frame, 0..1. */
  level: number
}

export const REST_SHAPE: MouthShape = {
  viseme: 'rest',
  openness: 0,
  width: 0,
  roundness: 0,
  teeth: 0,
  level: 0,
}

export const DEFAULT_HOP_MS = 20
const DEFAULT_WINDOW_MS = 25
const DEFAULT_FFT_SIZE = 512
/** Below this share of the loudest frame the mouth is considered closed. */
const NOISE_GATE = 0.06

/** Per-viseme mouth targets. Loudness scales the opening only. */
const VISEME_TARGETS: Record<
  Exclude<VisemeId, 'rest'>,
  { openness: number; width: number; roundness: number; teeth: number }
> = {
  // /a/-like: jaw down, lips neutral to slightly spread.
  wide: { openness: 0.92, width: 0.22, roundness: 0, teeth: 0 },
  // /u/, /o/-like: lips pushed forward, small opening.
  round: { openness: 0.44, width: -0.62, roundness: 1, teeth: 0 },
  // /i/, /e/-like: lips spread wide, narrow slit between them.
  narrow: { openness: 0.4, width: 0.62, roundness: 0.1, teeth: 0.25 },
  // /s/, /f/-like: teeth almost touching, lips spread.
  teeth: { openness: 0.24, width: 0.38, roundness: 0, teeth: 1 },
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const angle = (-2 * Math.PI) / len
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)
    for (let start = 0; start < n; start += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < half; k += 1) {
        const evenRe = re[start + k]
        const evenIm = im[start + k]
        const oddRe = re[start + k + half]
        const oddIm = im[start + k + half]
        const prodRe = oddRe * curRe - oddIm * curIm
        const prodIm = oddRe * curIm + oddIm * curRe
        re[start + k] = evenRe + prodRe
        im[start + k] = evenIm + prodIm
        re[start + k + half] = evenRe - prodRe
        im[start + k + half] = evenIm - prodIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

export function hopSamples(sampleRate: number, hopMs = DEFAULT_HOP_MS): number {
  return Math.max(1, Math.round((hopMs / 1000) * sampleRate))
}

export interface MouthAnalysisOptions {
  hopMs?: number
  windowMs?: number
  fftSize?: number
  /**
   * Loudness per frame in the 0..1 range. The default normalises against a
   * running peak, which keeps a long stream stable without knowing the
   * overall level up front.
   */
  loudness?: (frameIndex: number, rms: number) => number
}

interface BandEnergy {
  low: number
  mid: number
  high: number
  top: number
  centroid: number
}

function bandEnergy(
  magnitude: Float32Array,
  binHz: number,
  sampleRate: number,
): BandEnergy {
  const nyquist = sampleRate / 2
  const bands = { low: 0, mid: 0, high: 0, top: 0 }
  let total = 0
  let weighted = 0
  for (let bin = 1; bin < magnitude.length; bin += 1) {
    const hz = bin * binHz
    if (hz >= nyquist) break
    const power = magnitude[bin] * magnitude[bin]
    total += power
    weighted += power * hz
    if (hz < 700) bands.low += power
    else if (hz < 2000) bands.mid += power
    else if (hz < 4000) bands.high += power
    else bands.top += power
  }
  return {
    low: bands.low,
    mid: bands.mid,
    high: bands.high,
    top: bands.top,
    centroid: total > 0 ? weighted / total : 0,
  }
}

/**
 * Pick the mouth shape from the spectral balance.
 *
 * Vowels differ in where their two formants sit: /u/ and /o/ keep the energy
 * low and close to the first formant (rounded lips), /a/ and /e/ spread it
 * across the middle band (wide jaw drop) and /i/ pushes the second formant
 * above 2 kHz (narrow slit). Fricatives move everything above 4 kHz.
 */
function classify(bands: BandEnergy): Exclude<VisemeId, 'rest'> {
  const total = bands.low + bands.mid + bands.high + bands.top
  if (total <= 0) return 'wide'
  const lowRatio = bands.low / total
  const highRatio = bands.high / total
  const topRatio = bands.top / total
  // Fricatives push most of their energy above 4 kHz.
  if (topRatio > 0.3) return 'teeth'
  // /i/-like vowels push the second formant into the 2-4 kHz band.
  if (highRatio > 0.22) return 'narrow'
  // Rounded vowels keep the energy low and close to the first formant.
  if (lowRatio > 0.45 && bands.centroid < 850) return 'round'
  return 'wide'
}

/** Running-peak loudness normaliser, shared across streamed chunks. */
export function createRunningLoudness(): (frameIndex: number, rms: number) => number {
  let peak = 0.05
  return (_frameIndex, rms) => {
    if (rms > peak) peak = rms
    else peak *= 0.9995
    const reference = Math.max(peak * 0.85, 0.05)
    return clamp(rms / reference, 0, 1)
  }
}

/** Normalises against a fixed peak, for a buffer that is already complete. */
export function createFixedLoudness(reference: number): (frameIndex: number, rms: number) => number {
  const ref = Math.max(reference, 0.0001)
  return (_frameIndex, rms) => clamp(rms / ref, 0, 1)
}

/**
 * Reduce a PCM buffer to one mouth shape per hop.
 *
 * The returned shapes are not smoothed; use `MouthShapeSmoother` for that so
 * a streamed buffer and a complete one behave the same.
 */
export function analyzeMouthShapes(
  samples: Float32Array,
  sampleRate: number,
  options: MouthAnalysisOptions = {},
): MouthShape[] {
  const hopMs = options.hopMs ?? DEFAULT_HOP_MS
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const fftSize = options.fftSize ?? DEFAULT_FFT_SIZE
  const loudnessOf = options.loudness ?? createRunningLoudness()
  if (!samples.length || sampleRate <= 0) return []

  const hop = hopSamples(sampleRate, hopMs)
  // The window has to fit into the FFT, otherwise the tail of the window is
  // dropped from the spectrum while still counting towards the level.
  const windowLength = Math.min(
    fftSize,
    Math.max(hop, Math.round((windowMs / 1000) * sampleRate)),
  )
  const binHz = sampleRate / fftSize
  // One frame per hop; the window may reach past the end of a short buffer and
  // is zero-padded there, which keeps a streamed chunk analysable on its own.
  const frameCount = Math.max(0, Math.floor(samples.length / hop))
  if (frameCount <= 0) return []

  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const magnitude = new Float32Array(fftSize / 2)
  const shapes: MouthShape[] = []

  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * hop
    re.fill(0)
    im.fill(0)
    let sumSquares = 0
    for (let i = 0; i < windowLength; i += 1) {
      const sample = samples[offset + i] ?? 0
      sumSquares += sample * sample
      // Hann window keeps the spectrum from smearing across the frame.
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (windowLength - 1))
      re[i] = sample * w
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, windowLength))
    fft(re, im)
    for (let bin = 0; bin < magnitude.length; bin += 1) {
      magnitude[bin] = Math.hypot(re[bin], im[bin])
    }
    const bands = bandEnergy(magnitude, binHz, sampleRate)
    const loudness = loudnessOf(frame, rms)

    if (loudness < NOISE_GATE) {
      shapes.push({ ...REST_SHAPE, level: loudness })
      continue
    }
    const viseme = classify(bands)
    const target = VISEME_TARGETS[viseme]
    shapes.push({
      viseme,
      openness: clamp(target.openness * loudness, 0, 1),
      width: target.width,
      roundness: target.roundness * clamp(loudness * 1.4, 0, 1),
      teeth: target.teeth * clamp(loudness * 1.4, 0, 1),
      level: loudness,
    })
  }
  return shapes
}

/**
 * Reduce a shape to what the selected mouth model needs.
 *
 * The envelope model only opens the jaw with the loudness; the approximated
 * model keeps the analysed lip shape on top of it.
 */
export function shapeForMode(shape: MouthShape, mode: VisemeMode): MouthShape {
  if (mode === 'approx') return shape
  return {
    viseme: 'rest',
    openness: shape.level,
    width: 0,
    roundness: 0,
    teeth: 0,
    level: shape.level,
  }
}

export interface SmootherOptions {
  attackMs?: number
  releaseMs?: number
  hopMs?: number
  /** How long a mouth shape is kept before a different one may take over. */
  minHoldMs?: number
  /** Smoothing time for lip width / roundness / teeth, in milliseconds. */
  shapeMs?: number
}

/**
 * Temporal smoothing for mouth shapes.
 *
 * Opening follows the envelope quickly but closes slowly, and the viseme class
 * only changes once a new candidate survives a couple of frames — otherwise
 * the mouth flickers between shapes on every noise burst.
 */
export class MouthShapeSmoother {
  private attack: number
  private release: number
  private shapeAlpha: number
  private minHoldFrames: number
  private current: MouthShape = { ...REST_SHAPE }
  private hold = 0
  private candidate: VisemeId | null = null
  private candidateCount = 0

  constructor(options: SmootherOptions = {}) {
    const hopMs = options.hopMs ?? DEFAULT_HOP_MS
    const attackMs = options.attackMs ?? 30
    const releaseMs = options.releaseMs ?? 90
    const shapeMs = options.shapeMs ?? 80
    this.attack = Math.max(0, 1 - Math.exp(-hopMs / Math.max(1, attackMs)))
    this.release = Math.max(0, 1 - Math.exp(-hopMs / Math.max(1, releaseMs)))
    this.shapeAlpha = Math.max(0, 1 - Math.exp(-hopMs / Math.max(1, shapeMs)))
    this.minHoldFrames = Math.max(1, Math.round((options.minHoldMs ?? 60) / hopMs))
  }

  push(shape: MouthShape): MouthShape {
    const alpha = shape.openness > this.current.openness ? this.attack : this.release
    const openness = this.current.openness + (shape.openness - this.current.openness) * alpha
    const levelAlpha = shape.level > this.current.level ? this.attack : this.release
    const level = this.current.level + (shape.level - this.current.level) * levelAlpha

    const coming = shape.viseme
    let viseme = this.current.viseme
    if (coming === 'rest') {
      // Closing the mouth must never be delayed.
      viseme = 'rest'
      this.candidate = null
      this.candidateCount = 0
      this.hold = 0
    } else if (this.current.viseme === 'rest') {
      // The same goes for opening it: a delayed open reads as a broken lip
      // sync, so the first speaking frame takes over right away.
      viseme = coming
      this.candidate = null
      this.candidateCount = 0
      this.hold = 0
    } else if (coming === this.current.viseme) {
      this.candidate = null
      this.candidateCount = 0
      this.hold += 1
    } else {
      if (this.candidate === coming) this.candidateCount += 1
      else {
        this.candidate = coming
        this.candidateCount = 1
      }
      // Between two speaking shapes the mouth may not flip on every frame.
      if (this.hold >= this.minHoldFrames && this.candidateCount >= 2) {
        viseme = coming
        this.hold = 0
        this.candidate = null
        this.candidateCount = 0
      } else {
        this.hold += 1
      }
    }

    const rest = viseme === 'rest'
    // Width, roundness and teeth used to snap to the new viseme's target on
    // the same frame, which is what made the mouth look like it was flipping
    // between pre-drawn shapes. Ease all of them alongside the opening.
    const width = rest
      ? 0
      : this.current.width + (shape.width - this.current.width) * this.shapeAlpha
    const roundness = rest
      ? 0
      : this.current.roundness + (shape.roundness - this.current.roundness) * this.shapeAlpha
    const teeth = rest
      ? 0
      : this.current.teeth + (shape.teeth - this.current.teeth) * this.shapeAlpha
    this.current = {
      viseme,
      openness,
      width,
      roundness,
      teeth,
      level,
    }
    return this.current
  }

  reset(): void {
    this.current = { ...REST_SHAPE }
    this.hold = 0
    this.candidate = null
    this.candidateCount = 0
  }
}

/** Smooth a complete shape list with the same rules the streamer uses. */
export function smoothMouthShapes(
  shapes: MouthShape[],
  options: SmootherOptions = {},
): MouthShape[] {
  const smoother = new MouthShapeSmoother(options)
  return shapes.map((shape) => smoother.push(shape))
}
