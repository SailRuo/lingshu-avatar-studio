import { splitSpeechSentences } from '../providers/tts'
import { SpeechPlayer } from './player'
import { PcmStreamPlayer } from './pcmStreamPlayer'
import type { MouthShape, VisemeMode } from './viseme'

export interface LiveSpeechHandlers {
  /** Raw PCM frames as they arrive from the live session. */
  onAudio(pcm: Int16Array, sampleRate: number): void
  signal: AbortSignal
}

/**
 * A live speech source streams one utterance and pushes audio as it is
 * produced, instead of waiting for a complete file.
 */
export interface LiveSpeechSource {
  run(text: string, handlers: LiveSpeechHandlers): Promise<void>
}

export interface SpeakOptions {
  /** One-shot synthesis, one sentence at a time. */
  synthesize?: (text: string, signal: AbortSignal) => Promise<Blob>
  /** Live streaming synthesis; takes precedence over `synthesize`. */
  live?: LiveSpeechSource
  /** How the mouth follows the audio. */
  visemeMode?: VisemeMode
  onSentence?: (text: string, index: number) => void
  onError?: (error: unknown) => void
}

export class SpeechQueue {
  private player = new SpeechPlayer()
  private stream = new PcmStreamPlayer()
  private controller: AbortController | null = null
  private running = false

  get isPlaying(): boolean {
    return this.player.isPlaying
  }

  mouthOpen(): number {
    return this.mouthShape().openness
  }

  /** The mouth shape that belongs to the audio currently being heard. */
  mouthShape(): MouthShape {
    if (this.stream.isActive) return this.stream.shape()
    return this.player.mouthShape()
  }

  async speak(text: string, options: SpeakOptions): Promise<void> {
    this.stop()
    if (options.live) {
      await this.speakLive(text, options)
      return
    }
    if (!options.synthesize) return
    const sentences = splitSpeechSentences(text)
    if (!sentences.length) return
    const controller = new AbortController()
    this.controller = controller
    this.running = true
    try {
      for (let index = 0; index < sentences.length; index += 1) {
        if (controller.signal.aborted) break
        const sentence = sentences[index]
        options.onSentence?.(sentence, index)
        const blob = await options.synthesize!(sentence, controller.signal)
        if (controller.signal.aborted) break
        await this.player.play(blob, { visemeMode: options.visemeMode })
      }
    } catch (err) {
      if (!controller.signal.aborted) options.onError?.(err)
    } finally {
      if (this.controller === controller) {
        this.controller = null
        this.running = false
      }
    }
  }

  private async speakLive(text: string, options: SpeakOptions): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    this.running = true
    try {
      await this.stream.prepare({ visemeMode: options.visemeMode })
      await options.live!.run(text, {
        onAudio: (pcm, sampleRate) => this.stream.append(pcm, sampleRate),
        signal: controller.signal,
      })
      // The session is done but the audio may still be queued in the graph.
      await this.stream.waitForEnd()
    } catch (err) {
      if (!controller.signal.aborted) options.onError?.(err)
    } finally {
      if (this.controller === controller) {
        this.controller = null
        this.running = false
      }
      this.stream.stop()
    }
  }

  stop(): void {
    this.controller?.abort()
    this.controller = null
    this.running = false
    this.player.stop()
    this.stream.stop()
  }

  get active(): boolean {
    return this.running || this.player.isPlaying || this.stream.isActive
  }
}
