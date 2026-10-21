import type { CapabilityReport, CapabilityStatus, ProviderConfig, ProviderRole } from '../../types/provider'
import { chatOnce } from './chat'
import { ProviderError } from './http'
import { synthesizeSpeech } from './tts'

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='

function statusFromError(err: unknown): CapabilityStatus {
  if (!(err instanceof ProviderError)) return 'unknown'
  if (err.kind === 'cors') return 'cors_blocked'
  if (err.kind === 'auth') return 'auth_error'
  if (err.kind === 'rate_limit') return 'quota'
  if (err.kind === 'model') return 'model_missing'
  if (err.kind === 'network') return 'network'
  if (err.kind === 'unsupported') return 'unsupported'
  return 'unknown'
}

function messageFromError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function report(
  provider: ProviderConfig,
  role: ProviderRole,
  status: CapabilityStatus,
  startedAt: number,
  model: string,
  message: string,
  extra: Partial<CapabilityReport> = {},
): CapabilityReport {
  return {
    providerId: provider.id,
    role,
    status,
    latencyMs: Math.round(performance.now() - startedAt),
    model,
    message,
    testedAt: Date.now(),
    ...extra,
  }
}

export async function testAgentProvider(
  provider: ProviderConfig,
  apiKey: string,
): Promise<CapabilityReport> {
  const startedAt = performance.now()
  const model = provider.models.chat ?? ''
  if (!model) {
    return report(provider, 'chat', 'model_missing', startedAt, model, '没有填写多模态模型 ID。')
  }
  if (!apiKey) {
    return report(provider, 'chat', 'auth_error', startedAt, model, '没有填写 API Key。')
  }
  try {
    await chatOnce({
      provider,
      apiKey,
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '你收到图片了吗？只回复 YES。' },
            { type: 'image_url', image_url: { url: TINY_PNG } },
          ],
        },
      ],
      temperature: 0,
    })
    return report(provider, 'chat', 'ok', startedAt, model, '多模态连接正常（对话 + 看图）。')
  } catch (err) {
    return report(provider, 'chat', statusFromError(err), startedAt, model, messageFromError(err), {
      httpStatus: err instanceof ProviderError ? err.status : undefined,
    })
  }
}

export async function testTtsProvider(
  provider: ProviderConfig,
  apiKey: string,
): Promise<CapabilityReport> {
  const startedAt = performance.now()
  const model = provider.models.tts ?? ''
  if (!apiKey) return report(provider, 'tts', 'auth_error', startedAt, model, '没有填写 API Key。')
  try {
    const blob = await synthesizeSpeech({ provider, apiKey, text: '测试' })
    if (blob.size < 512) {
      return report(provider, 'tts', 'unknown', startedAt, model, '返回的音频过小，可能不是有效音频。')
    }
    return report(provider, 'tts', 'ok', startedAt, model, `语音合成正常（${Math.round(blob.size / 1024)} KB）。`)
  } catch (err) {
    return report(provider, 'tts', statusFromError(err), startedAt, model, messageFromError(err), {
      httpStatus: err instanceof ProviderError ? err.status : undefined,
    })
  }
}
