import { computeEnvelope, sampleEnvelope, type Envelope } from './envelope'
import {
  analyzeMouthShapes,
  DEFAULT_HOP_MS,
  MouthShapeSmoother,
  REST_SHAPE,
  shapeForMode,
  type MouthShape,
  type VisemeMode,
} from './viseme'

let sharedContext: AudioContext | null = null

export function getAudioContext(): AudioContext {
  if (!sharedContext) {
    sharedContext = new AudioContext()
  }
  return sharedContext
}

export async function ensureAudioUnlocked(): Promise<AudioContext> {
  const ctx = getAudioContext()
  if (ctx.state === 'suspended') await ctx.resume()
  return ctx
}

let unlockInstalled = false

/**
 * Unlocks audio on the first user gesture.
 *
 * WebKit refuses to resume an AudioContext outside a gesture, and speech is
 * only played once synthesis returns, seconds after the click that started it.
 * By then the gesture is gone and resume() silently leaves the context
 * suspended: the audio graph is built, the source starts, and nothing is
 * heard. Resuming here, while the gesture is still live, is what makes later
 * playback audible.
 */
export function installAudioUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return
  unlockInstalled = true
  const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart']
  const unlock = () => {
    const ctx = getAudioContext()
    // Keep the listeners until the context is actually running: a single
    // attempt can be ignored before the page has settled, and removing them
    // then leaves audio silently muted for the rest of the session.
    void (async () => {
      try {
        if (ctx.state !== 'running') await ctx.resume()
      } catch {
        return
      }
      if (ctx.state !== 'running') return
      // A one-sample silent buffer is what WebKit accepts as "played audio";
      // some versions keep the context muted until it has produced something.
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start(0)
      for (const event of events) window.removeEventListener(event, unlock, true)
    })()
  }
  for (const event of events) window.addEventListener(event, unlock, true)
}

export class SpeechPlayer {
  private source: AudioBufferSourceNode | null = null
  private gain: GainNode | null = null
  private envelope: Envelope | null = null
  private shapes: MouthShape[] = []
  private visemeMode: VisemeMode = 'envelope'
  private startedAt = 0
  private ended = false
  private stopResolve: (() => void) | null = null

  get isPlaying(): boolean {
    return !!this.source && !this.ended
  }

  async play(blob: Blob, options: { visemeMode?: VisemeMode } = {}): Promise<void> {
    const ctx = await ensureAudioUnlocked()
    if (ctx.state !== 'running') {
      // One more attempt outside the original gesture. If the context still
      // refuses to run, saying nothing would look like a silent bug: nothing
      // is heard and speak() never resolves. Say what happened instead.
      try {
        await ctx.resume()
      } catch {
        // fall through to the check below
      }
    }
    if (ctx.state !== 'running') {
      throw new Error('系统暂时不允许播放音频，请点击页面任意位置后重新发送。')
    }
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
    this.stop()
    this.visemeMode = options.visemeMode ?? 'envelope'
    const envelope = computeEnvelope(buffer)
    // The envelope already carries a normalised, gated loudness curve, so it
    // doubles as the loudness source for the mouth-shape analysis.
    const raw = analyzeMouthShapes(buffer.getChannelData(0), buffer.sampleRate, {
      hopMs: DEFAULT_HOP_MS,
      loudness: (index) => envelope.values[index] ?? 0,
    })
    const smoother = new MouthShapeSmoother({ hopMs: DEFAULT_HOP_MS })
    this.shapes = raw.map((shape) => smoother.push(shape))
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = 1
    source.connect(gain)
    gain.connect(ctx.destination)
    this.source = source
    this.gain = gain
    this.envelope = envelope
    this.startedAt = ctx.currentTime + 0.035
    this.ended = false
    const done = new Promise<void>((resolve) => {
      this.stopResolve = resolve
      source.onended = () => {
        this.ended = true
        this.source = null
        this.envelope = null
        this.stopResolve = null
        resolve()
      }
    })
    source.start(this.startedAt)
    return done
  }

  mouthOpen(): number {
    if (!this.source || !this.envelope) return 0
    const ctx = getAudioContext()
    const elapsedMs = (ctx.currentTime - this.startedAt) * 1000
    return sampleEnvelope(this.envelope, elapsedMs, 80)
  }

  /** The mouth shape that belongs to the audio currently being heard. */
  mouthShape(): MouthShape {
    if (!this.source || !this.shapes.length) return REST_SHAPE
    const ctx = getAudioContext()
    const elapsedMs = (ctx.currentTime - this.startedAt) * 1000
    const index = Math.floor((elapsedMs - 80) / DEFAULT_HOP_MS)
    if (index < 0) return REST_SHAPE
    const shape = this.shapes[Math.min(this.shapes.length - 1, index)] ?? REST_SHAPE
    return shapeForMode(shape, this.visemeMode)
  }

  stop(): void {
    if (this.source) {
      try {
        this.source.stop()
      } catch {
        // already stopped
      }
      this.source.disconnect()
      this.source = null
    }
    if (this.gain) {
      this.gain.disconnect()
      this.gain = null
    }
    this.envelope = null
    this.shapes = []
    this.ended = true
    this.stopResolve?.()
    this.stopResolve = null
  }
}
