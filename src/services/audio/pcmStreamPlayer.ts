import { ensureAudioUnlocked, getAudioContext } from './player'
import {
  analyzeMouthShapes,
  createRunningLoudness,
  DEFAULT_HOP_MS,
  hopSamples,
  MouthShapeSmoother,
  REST_SHAPE,
  shapeForMode,
  type MouthShape,
  type VisemeMode,
} from './viseme'

/** Output latency between the audio graph and the speaker, in milliseconds. */
const OUTPUT_LEAD_MS = 80
/** First chunk is scheduled a moment ahead so the graph is already running. */
const PREBUFFER_SECONDS = 0.06

/**
 * Plays a PCM stream and keeps a mouth-shape timeline in sync with it.
 *
 * Chunks are scheduled back to back on the audio clock, so the playback
 * position is known exactly and the mouth shapes can be sampled from the same
 * timeline instead of guessing from wall-clock time.
 */
export class PcmStreamPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private sources: AudioBufferSourceNode[] = []
  private startTime = 0
  private nextTime = 0
  private started = false
  private stopped = false
  private sampleRate = 24000
  private shapes: MouthShape[] = []
  private smoother = new MouthShapeSmoother({ hopMs: DEFAULT_HOP_MS })
  private loudness = createRunningLoudness()
  private visemeMode: VisemeMode = 'envelope'
  private analysisBuffer = new Float32Array(0)
  private frameIndex = 0
  private endTimer: ReturnType<typeof setTimeout> | null = null
  private endResolve: (() => void) | null = null
  private endPromise: Promise<void> | null = null

  get isActive(): boolean {
    return this.started && !this.stopped
  }

  async prepare(options: { visemeMode?: VisemeMode } = {}): Promise<void> {
    const ctx = await ensureAudioUnlocked()
    this.ctx = ctx
    if (!this.gain) {
      const gain = ctx.createGain()
      gain.gain.value = 1
      gain.connect(ctx.destination)
      this.gain = gain
    }
    // Arm the player for a new stream: a previous `stop()` must not keep
    // dropping the incoming chunks.
    this.stopped = false
    this.started = false
    this.startTime = 0
    this.nextTime = 0
    this.shapes = []
    this.frameIndex = 0
    this.analysisBuffer = new Float32Array(0)
    this.smoother.reset()
    this.loudness = createRunningLoudness()
    this.visemeMode = options.visemeMode ?? 'envelope'
  }

  /** Queue one PCM chunk (s16le mono) for playback and analysis. */
  append(pcm: Int16Array, sampleRate: number): void {
    if (this.stopped || !pcm.length) return
    const ctx = this.ctx ?? getAudioContext()
    this.ctx = ctx
    if (!this.gain) {
      const gain = ctx.createGain()
      gain.gain.value = 1
      gain.connect(ctx.destination)
      this.gain = gain
    }
    if (sampleRate > 0) this.sampleRate = sampleRate

    const samples = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768

    if (!this.started) {
      this.started = true
      this.startTime = ctx.currentTime + PREBUFFER_SECONDS
      this.nextTime = this.startTime
    }

    const buffer = ctx.createBuffer(1, samples.length, this.sampleRate)
    buffer.copyToChannel(samples, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)
    source.start(this.nextTime)
    this.sources.push(source)
    this.nextTime += buffer.duration

    this.analyze(samples)
    this.armEndTimer()
  }

  private analyze(samples: Float32Array): void {
    const merged = new Float32Array(this.analysisBuffer.length + samples.length)
    merged.set(this.analysisBuffer, 0)
    merged.set(samples, this.analysisBuffer.length)
    this.analysisBuffer = merged

    const hop = hopSamples(this.sampleRate, DEFAULT_HOP_MS)
    const frames = analyzeMouthShapes(this.analysisBuffer, this.sampleRate, {
      hopMs: DEFAULT_HOP_MS,
      loudness: this.loudness,
    })
    if (!frames.length) return
    for (const frame of frames) {
      this.shapes[this.frameIndex] = this.smoother.push(frame)
      this.frameIndex += 1
    }
    const consumed = frames.length * hop
    this.analysisBuffer = this.analysisBuffer.slice(consumed)
  }

  /** The mouth shape that belongs to the audio currently being heard. */
  shape(): MouthShape {
    if (!this.started || this.stopped) return REST_SHAPE
    const ctx = this.ctx ?? getAudioContext()
    const elapsedMs = (ctx.currentTime - this.startTime) * 1000 - OUTPUT_LEAD_MS
    if (elapsedMs < 0) return REST_SHAPE
    const hop = hopSamples(this.sampleRate, DEFAULT_HOP_MS)
    const index = Math.floor((elapsedMs / 1000) * this.sampleRate) / hop
    const shape = this.shapes[Math.floor(index)]
    if (!shape) return REST_SHAPE
    return shapeForMode(shape, this.visemeMode)
  }

  /** Resolves once every queued chunk has been played out. */
  waitForEnd(): Promise<void> {
    if (!this.endPromise) {
      this.endPromise = new Promise<void>((resolve) => {
        this.endResolve = resolve
        // Nothing was ever queued, so there is nothing left to wait for.
        if (!this.started || this.stopped) {
          resolve()
          this.endResolve = null
          return
        }
        this.armEndTimer()
      })
    }
    return this.endPromise
  }

  private armEndTimer(): void {
    if (this.endTimer) {
      clearTimeout(this.endTimer)
      this.endTimer = null
    }
    if (!this.started || this.stopped) return
    const ctx = this.ctx
    if (!ctx) return
    const remaining = (this.nextTime - ctx.currentTime) * 1000
    this.endTimer = setTimeout(() => {
      this.endTimer = null
      if (this.ctx && this.ctx.currentTime < this.nextTime - 0.01) {
        this.armEndTimer()
        return
      }
      this.endResolve?.()
      this.endResolve = null
    }, Math.max(0, remaining) + 30)
  }

  stop(): void {
    this.stopped = true
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // Already stopped.
      }
      source.disconnect()
    }
    this.sources = []
    if (this.endTimer) {
      clearTimeout(this.endTimer)
      this.endTimer = null
    }
    this.endResolve?.()
    this.endResolve = null
    if (this.gain) {
      this.gain.disconnect()
      this.gain = null
    }
    this.smoother.reset()
    this.shapes = []
    this.analysisBuffer = new Float32Array(0)
    this.frameIndex = 0
    this.started = false
  }
}
