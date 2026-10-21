export interface Envelope {
  values: Float32Array
  hopMs: number
  durationMs: number
}

export interface EnvelopeOptions {
  hopMs?: number
  noiseGate?: number
  gamma?: number
  attackMs?: number
  releaseMs?: number
}

export function computeEnvelope(buffer: AudioBuffer, options: EnvelopeOptions = {}): Envelope {
  const hopMs = options.hopMs ?? 20
  const noiseGate = options.noiseGate ?? 0.05
  const gamma = options.gamma ?? 0.8
  const attackMs = options.attackMs ?? 30
  const releaseMs = options.releaseMs ?? 90
  const data = buffer.getChannelData(0)
  const sampleRate = buffer.sampleRate
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate))
  const frames = Math.max(1, Math.ceil(data.length / hop))
  const raw = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * hop
    const end = Math.min(data.length, start + hop)
    let sum = 0
    for (let i = start; i < end; i += 1) sum += data[i] * data[i]
    raw[frame] = Math.sqrt(sum / Math.max(1, end - start))
  }
  const sorted = Array.from(raw).sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 1
  const normalized = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    const value = Math.max(0, raw[i] / Math.max(0.0001, p95))
    normalized[i] = Math.pow(value, gamma)
  }
  const attack = Math.max(0, 1 - Math.exp(-hopMs / Math.max(1, attackMs)))
  const release = Math.max(0, 1 - Math.exp(-hopMs / Math.max(1, releaseMs)))
  const smoothed = new Float32Array(frames)
  let current = 0
  for (let i = 0; i < frames; i += 1) {
    const target = normalized[i] < noiseGate ? 0 : normalized[i]
    const alpha = target > current ? attack : release
    current += (target - current) * alpha
    smoothed[i] = Math.min(1, current)
  }
  return {
    values: smoothed,
    hopMs,
    durationMs: (data.length / sampleRate) * 1000,
  }
}

export function sampleEnvelope(envelope: Envelope, timeMs: number, leadMs = 80): number {
  const index = Math.floor((timeMs - leadMs) / envelope.hopMs)
  if (index < 0) return 0
  if (index >= envelope.values.length) return 0
  const next = envelope.values[Math.min(envelope.values.length - 1, index + 1)]
  const frac = ((timeMs - leadMs) / envelope.hopMs) % 1
  return envelope.values[index] * (1 - frac) + next * frac
}
