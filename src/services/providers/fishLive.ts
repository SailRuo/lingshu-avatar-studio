import type { ProviderConfig } from '../../types/provider'
import { getPlatform, isNativeRuntime } from '../platform/bridge'
import { fishLatency } from './tts'

/** Fish live PCM is raw s16le mono; the app pins the same rate. */
export const FISH_PCM_SAMPLE_RATE = 24000

export interface FishLiveRequest {
  provider: ProviderConfig
  apiKey: string
  model: string
  referenceId: string
}

export interface FishLiveHandlers {
  /** Raw PCM frames, already decoded to signed 16-bit mono samples. */
  onAudio(pcm: Int16Array, sampleRate: number): void
  onFinish(reason: string): void
  onError(error: Error): void
}

export function fishLiveSupported(): boolean {
  return isNativeRuntime() && !!getPlatform().fish
}

/**
 * One Fish live session.
 *
 * The socket lives in the native layer (a browser WebSocket cannot send the
 * Authorization header Fish requires), so this class only forwards text in
 * and PCM frames out.
 */
export class FishLiveSession {
  readonly token: string
  private readonly handlers: FishLiveHandlers
  private unsubscribe: (() => void) | null = null
  private finished = false

  constructor(request: FishLiveRequest, handlers: FishLiveHandlers) {
    const platform = getPlatform()
    if (!isNativeRuntime() || !platform.fish) {
      throw new Error('Fish 实时流播需要桌面端；浏览器版请使用一次性合成。')
    }
    this.handlers = handlers
    this.token = `fish_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.unsubscribe = platform.fish.onEvent((event) => {
      if (event.token !== this.token) return
      if (event.type === 'audio') {
        const bytes = event.data
        if (!bytes || !bytes.byteLength) return
        // Fish sends s16le mono PCM; an odd byte count would shift every
        // following sample, so drop the trailing byte instead.
        const usable = bytes.byteLength - (bytes.byteLength % 2)
        if (!usable) return
        const view = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2)
        this.handlers.onAudio(view, FISH_PCM_SAMPLE_RATE)
        return
      }
      if (event.type === 'finish') {
        this.finished = true
        this.handlers.onFinish(event.reason)
        return
      }
      if (event.type === 'error') {
        this.finished = true
        this.handlers.onError(new Error(event.message || 'Fish Audio 合成失败。'))
        return
      }
      if (event.type === 'closed') {
        if (this.finished) return
        this.finished = true
        this.handlers.onError(new Error('Fish Audio 连接提前关闭。'))
      }
    })
    platform.fish.start({
      token: this.token,
      baseUrl: request.provider.baseUrl,
      apiKey: request.apiKey,
      model: request.model,
      referenceId: request.referenceId,
      format: 'pcm',
      latency: fishLatency(request.provider),
      sampleRate: FISH_PCM_SAMPLE_RATE,
    })
  }

  sendText(text: string): void {
    const trimmed = text.trim()
    if (!trimmed || this.finished) return
    getPlatform().fish.text({ token: this.token, text: trimmed })
  }

  flush(): void {
    if (this.finished) return
    getPlatform().fish.flush({ token: this.token })
  }

  stop(): void {
    if (this.finished) return
    getPlatform().fish.stop({ token: this.token })
  }

  cancel(): void {
    this.finished = true
    getPlatform().fish.cancel({ token: this.token })
    this.dispose()
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}

export interface FishSpeakOptions {
  provider: ProviderConfig
  apiKey: string
  text: string
  model: string
  referenceId: string
  signal?: AbortSignal
  onAudio: (pcm: Int16Array, sampleRate: number) => void
  onFinish?: () => void
}

/**
 * Stream a whole utterance through one Fish live session.
 *
 * Resolves once the server finished the turn; rejects on transport errors.
 */
export function speakFishLive(options: FishSpeakOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let session: FishLiveSession | null = null
    let onAbort: (() => void) | null = null
    let progressTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (progressTimer) {
        clearTimeout(progressTimer)
        progressTimer = null
      }
      if (onAbort) options.signal?.removeEventListener('abort', onAbort)
      session?.dispose()
    }
    /**
     * The gateway streams audio while it synthesizes, so a turn that stops
     * making progress is stalled. Without this a dead session would keep the
     * character in "正在说话" forever.
     */
    const waitForProgress = () => {
      if (progressTimer) clearTimeout(progressTimer)
      progressTimer = setTimeout(() => {
        session?.cancel()
        fail(new Error('Fish Audio 实时合成超时，请重试。'))
      }, 20000)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      options.onFinish?.()
      resolve()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    try {
      session = new FishLiveSession(
        {
          provider: options.provider,
          apiKey: options.apiKey,
          model: options.model,
          referenceId: options.referenceId,
        },
        {
          onAudio: (pcm, sampleRate) => {
            waitForProgress()
            options.onAudio(pcm, sampleRate)
          },
          onFinish: finish,
          onError: fail,
        },
      )
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
      return
    }

    onAbort = () => {
      session?.cancel()
      fail(new Error('朗读已取消。'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) {
      onAbort()
      return
    }

    waitForProgress()
    session.sendText(options.text)
    session.flush()
    session.stop()
  })
}
