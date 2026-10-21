import type { ProviderConfig } from '../../types/provider'
import { ProviderError } from './http'
import { fetchModelList } from './models'
import { synthesizeSpeech } from './tts'

export interface ConnectivityResult {
  ok: boolean
  models: string[]
  message: string
}

/**
 * Generic provider probe. The provider entity only knows address + key, so
 * connectivity is validated through the OpenAI-compatible model list.
 */
export async function testProviderConnection(
  provider: ProviderConfig,
  apiKey: string,
): Promise<ConnectivityResult> {
  if (!provider.baseUrl) {
    throw new ProviderError('bad_request', '服务商地址为空。', { providerId: provider.id })
  }
  if (!apiKey) {
    throw new ProviderError('auth', '没有填写 API Key。', { providerId: provider.id })
  }
  if (provider.kind === 'fishaudio') {
    // Fish exposes no model list, so the only honest probe is a real
    // synthesis; it also proves the reference id is usable.
    const blob = await synthesizeSpeech({ provider, apiKey, text: '你好' })
    return {
      ok: true,
      models: [],
      message: `连接正常，已合成 ${Math.max(1, Math.round(blob.size / 1024))} KB 测试语音。`,
    }
  }
  try {
    const models = await fetchModelList(provider, apiKey)
    return {
      ok: true,
      models,
      message: models.length
        ? `连接正常，获取到 ${models.length} 个模型。`
        : '接口可达，但服务商没有返回模型列表。',
    }
  } catch (error) {
    if (
      error instanceof ProviderError &&
      (error.kind === 'model' || error.kind === 'bad_request')
    ) {
      throw new ProviderError(
        'bad_request',
        `${provider.baseUrl.replace(/\/+$/, '')}/models 不可用；请确认地址是 OpenAI 兼容接口。`,
        { providerId: provider.id, status: error.status },
      )
    }
    throw error
  }
}
