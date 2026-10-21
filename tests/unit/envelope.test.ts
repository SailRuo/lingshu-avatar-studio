import { describe, expect, it } from 'vitest'
import { computeEnvelope, sampleEnvelope } from '../../src/services/audio/envelope'

function fakeBuffer(samples: Float32Array, sampleRate = 1000): AudioBuffer {
  return {
    sampleRate,
    length: samples.length,
    duration: samples.length / sampleRate,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer
}

describe('audio envelope', () => {
  it('keeps silence at zero', () => {
    const envelope = computeEnvelope(fakeBuffer(new Float32Array(1000)), { noiseGate: 0 })
    expect(Math.max(...envelope.values)).toBe(0)
  })

  it('normalizes a sine wave and gates the tail', () => {
    const samples = new Float32Array(1000)
    for (let i = 0; i < 500; i += 1) samples[i] = Math.sin((i / 1000) * Math.PI * 2 * 20)
    const envelope = computeEnvelope(fakeBuffer(samples), { noiseGate: 0.05 })
    expect(Math.max(...envelope.values)).toBeGreaterThan(0.9)
    expect(envelope.values[envelope.values.length - 1]).toBeLessThan(0.05)
    expect(sampleEnvelope(envelope, 250, 0)).toBeGreaterThan(0.5)
    expect(sampleEnvelope(envelope, 900, 0)).toBeLessThan(0.02)
  })
})
