import type { ProviderConfig } from '../../types/provider'
import { hexToBytes } from '../imaging/blob'
import {
  applyProxy,
  errorFromFetch,
  errorFromResponse,
  joinUrl,
  readErrorPayload,
  ProviderError,
} from './http'

export interface TtsOptions {
  provider: ProviderConfig
  apiKey: string
  text: string
  voice?: string
  modelOverride?: string
  signal?: AbortSignal
}

function pickVoice(provider: ProviderConfig, voice?: string): string {
  return voice || provider.extra.voiceId || provider.extra.defaultVoice || 'alloy'
}

/**
 * Fish Audio 用音色模型 ID（reference_id）选音色，不接受 OpenAI 那种 voice 名称。
 * 角色档案里的音色优先，其次是服务商详情页保存的 reference_id。
 */
export function pickReferenceId(provider: ProviderConfig, voice?: string): string {
  return (voice || provider.extra.referenceId || provider.extra.voiceId || '').trim()
}

export function fishLatency(provider: ProviderConfig): string {
  const value = (provider.extra.latency || 'balanced').trim()
  return ['low_latency', 'balanced', 'high_quality'].includes(value) ? value : 'balanced'
}

function pickModel(provider: ProviderConfig, override?: string): string {
  return override || provider.models.tts || ''
}

async function synthesizeOpenAi(options: TtsOptions): Promise<Blob> {
  const model = pickModel(options.provider, options.modelOverride) || 'tts-1'
  const url = applyProxy(
    joinUrl(options.provider.baseUrl, '/audio/speech'),
    options.provider.proxyUrl,
  )
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: options.text,
        voice: pickVoice(options.provider, options.voice),
        response_format: 'mp3',
      }),
      signal: options.signal,
    })
  } catch (err) {
    throw errorFromFetch(err, options.provider.id)
  }
  if (!res.ok) {
    const payload = await readErrorPayload(res)
    throw errorFromResponse(res, payload, options.provider.id)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const payload = await res.json().catch(() => ({}))
    throw new ProviderError('bad_request', 'TTS 返回了 JSON 而不是音频。', {
      providerId: options.provider.id,
      status: res.status,
    })
  }
  return res.blob()
}

interface MiniMaxResponse {
  data?: { audio?: string }
  base_resp?: { status_code?: number; status_msg?: string }
}

async function synthesizeMiniMax(options: TtsOptions): Promise<Blob> {
  const groupId = options.provider.extra.groupId
  if (!groupId) throw new ProviderError('bad_request', 'MiniMax 需要填写 GroupId。')
  const url = applyProxy(
    joinUrl(options.provider.baseUrl, `/t2a_v2?GroupId=${encodeURIComponent(groupId)}`),
    options.provider.proxyUrl,
  )
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: pickModel(options.provider, options.modelOverride) || 'speech-2.6-hd',
        text: options.text,
        stream: false,
        voice_setting: {
          voice_id: pickVoice(options.provider, options.voice),
          speed: 1,
          vol: 1,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
        },
      }),
      signal: options.signal,
    })
  } catch (err) {
    throw errorFromFetch(err, options.provider.id)
  }
  if (!res.ok) {
    const payload = await readErrorPayload(res)
    throw errorFromResponse(res, payload, options.provider.id)
  }
  const json = (await res.json()) as MiniMaxResponse
  if (json.base_resp?.status_code && json.base_resp.status_code !== 0) {
    throw new ProviderError('bad_request', json.base_resp.status_msg || 'MiniMax TTS 失败。', {
      providerId: options.provider.id,
    })
  }
  const audio = json.data?.audio
  if (!audio) throw new ProviderError('bad_request', 'MiniMax 没有返回音频。')
  return new Blob([hexToBytes(audio)], { type: 'audio/mpeg' })
}

async function synthesizeElevenLabs(options: TtsOptions): Promise<Blob> {
  const voiceId = pickVoice(options.provider, options.voice)
  const url = applyProxy(
    joinUrl(options.provider.baseUrl, `/text-to-speech/${encodeURIComponent(voiceId)}`),
    options.provider.proxyUrl,
  )
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': options.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: options.text,
        model_id: pickModel(options.provider, options.modelOverride) || 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: options.signal,
    })
  } catch (err) {
    throw errorFromFetch(err, options.provider.id)
  }
  if (!res.ok) {
    const payload = await readErrorPayload(res)
    throw errorFromResponse(res, payload, options.provider.id)
  }
  return res.blob()
}

/**
 * Fish Audio 一次性合成。实时流播走 FishLiveSession，这里只用于联通测试、
 * 浏览器版兜底和「试听」这类不需要低延迟的场合。
 * 响应体是裸音频流（不是 base64、不是 JSON）。
 */
async function synthesizeFish(options: TtsOptions): Promise<Blob> {
  const model = pickModel(options.provider, options.modelOverride) || 's2.1-pro-free'
  const url = applyProxy(joinUrl(options.provider.baseUrl, '/v1/tts'), options.provider.proxyUrl)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        model,
      },
      body: JSON.stringify({
        text: options.text,
        reference_id: pickReferenceId(options.provider, options.voice),
        format: 'mp3',
        latency: fishLatency(options.provider),
      }),
      signal: options.signal,
    })
  } catch (err) {
    throw errorFromFetch(err, options.provider.id)
  }
  if (!res.ok) {
    const payload = await readErrorPayload(res)
    throw errorFromResponse(res, payload, options.provider.id)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const payload = await readErrorPayload(res)
    throw errorFromResponse(res, payload, options.provider.id)
  }
  return res.blob()
}

export async function synthesizeSpeech(options: TtsOptions): Promise<Blob> {
  if (!options.provider.baseUrl) throw new ProviderError('bad_request', '服务商 Base URL 为空。')
  if (!options.text.trim()) throw new ProviderError('bad_request', 'TTS 文本为空。')
  if (options.provider.kind === 'minimax') return synthesizeMiniMax(options)
  if (options.provider.kind === 'elevenlabs') return synthesizeElevenLabs(options)
  if (options.provider.kind === 'fishaudio') return synthesizeFish(options)
  return synthesizeOpenAi(options)
}

export function splitSpeechSentences(text: string, maxLength = 120): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const parts = normalized.split(/(?<=[。！？!?；;])\s*/u).filter(Boolean)
  const chunks: string[] = []
  for (const part of parts) {
    if (part.length <= maxLength) {
      chunks.push(part)
      continue
    }
    for (let i = 0; i < part.length; i += maxLength) {
      chunks.push(part.slice(i, i + maxLength))
    }
  }
  return chunks.filter((chunk) => chunk.trim().length > 0)
}
