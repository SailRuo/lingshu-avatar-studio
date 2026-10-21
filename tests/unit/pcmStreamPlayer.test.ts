import { beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_RATE = 24000

class FakeAudioContext {
  currentTime = 0
  state = 'running'
  destination = {}
  createdBuffers: Array<{ length: number; sampleRate: number }> = []
  scheduled: Array<{ startAt: number; duration: number }> = []

  createGain() {
    return {
      gain: { value: 1 },
      connect: () => {},
      disconnect: () => {},
    }
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    this.createdBuffers.push({ length, sampleRate })
    const data = new Float32Array(length)
    return {
      length,
      sampleRate,
      numberOfChannels: 1,
      duration: length / sampleRate,
      getChannelData: () => data,
      copyToChannel: (source: Float32Array) => {
        data.set(source)
      },
    }
  }

  createBufferSource() {
    const source = {
      buffer: null as { duration: number } | null,
      connect: () => {},
      disconnect: () => {},
      start: (at: number) => {
        this.scheduled.push({ startAt: at, duration: source.buffer?.duration ?? 0 })
      },
      stop: () => {},
    }
    return source
  }

  async resume() {
    this.state = 'running'
  }
}

let context: FakeAudioContext

beforeAll(() => {
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = function AudioContextStub() {
    context = new FakeAudioContext()
    return context
  }
})

/** A rounded vowel: energy low and close to the first formant. */
function roundedVowelPcm(seconds: number): Int16Array {
  const count = Math.round(seconds * SAMPLE_RATE)
  const pcm = new Int16Array(count)
  for (let i = 0; i < count; i += 1) {
    const value = Math.sin((i / SAMPLE_RATE) * Math.PI * 2 * 320) * 0.4
    pcm[i] = Math.round(value * 32767)
  }
  return pcm
}

describe('pcm stream player', () => {
  it('schedules chunks back to back on the audio clock', async () => {
    const { PcmStreamPlayer } = await import('../../src/services/audio/pcmStreamPlayer')
    const player = new PcmStreamPlayer()
    await player.prepare()
    player.append(roundedVowelPcm(0.5), SAMPLE_RATE)
    player.append(roundedVowelPcm(0.5), SAMPLE_RATE)

    expect(context.scheduled.length).toBe(2)
    const [first, second] = context.scheduled
    expect(first.startAt).toBeGreaterThan(0)
    // The second chunk has to start exactly where the first one ends.
    expect(second.startAt).toBeCloseTo(first.startAt + first.duration, 6)
    expect(second.duration).toBeCloseTo(0.5, 3)
    player.stop()
  })

  it('reports the mouth shape of the audio being heard', async () => {
    const { PcmStreamPlayer } = await import('../../src/services/audio/pcmStreamPlayer')
    const player = new PcmStreamPlayer()
    context.currentTime = 0
    await player.prepare({ visemeMode: 'approx' })
    player.append(roundedVowelPcm(1), SAMPLE_RATE)

    // Before the first chunk is audible the mouth stays closed.
    context.currentTime = 0.01
    expect(player.shape().openness).toBe(0)

    // Half a second into the utterance the rounded shape must show.
    context.currentTime = 0.56
    const shape = player.shape()
    expect(shape.viseme).toBe('round')
    expect(shape.openness).toBeGreaterThan(0.1)
    expect(shape.width).toBeLessThan(0)
    player.stop()
  })

  it('only follows the loudness in the envelope mode', async () => {
    const { PcmStreamPlayer } = await import('../../src/services/audio/pcmStreamPlayer')
    const player = new PcmStreamPlayer()
    context.currentTime = 0
    await player.prepare({ visemeMode: 'envelope' })
    player.append(roundedVowelPcm(1), SAMPLE_RATE)

    context.currentTime = 0.56
    const shape = player.shape()
    expect(shape.openness).toBeGreaterThan(0.1)
    // The envelope model has no lip shape, only a level.
    expect(shape.viseme).toBe('rest')
    expect(shape.width).toBe(0)
    expect(shape.roundness).toBe(0)
    player.stop()
  })

  it('resolves the end promise when nothing was played', async () => {
    const { PcmStreamPlayer } = await import('../../src/services/audio/pcmStreamPlayer')
    const player = new PcmStreamPlayer()
    await player.prepare()
    await expect(player.waitForEnd()).resolves.toBeUndefined()
    player.stop()
  })

  it('accepts audio again after a stop', async () => {
    const { PcmStreamPlayer } = await import('../../src/services/audio/pcmStreamPlayer')
    const player = new PcmStreamPlayer()
    await player.prepare()
    player.stop()
    // A queue stops the player before every utterance; a stopped player must
    // not keep dropping the next stream.
    await player.prepare()
    const before = context.scheduled.length
    player.append(roundedVowelPcm(0.2), SAMPLE_RATE)
    expect(context.scheduled.length).toBe(before + 1)
    player.stop()
  })
})
