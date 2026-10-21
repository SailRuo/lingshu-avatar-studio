import type { ProviderConfig } from '../../types/provider'
import {
  applyProxy,
  errorFromFetch,
  errorFromResponse,
  joinUrl,
  readErrorPayload,
  ProviderError,
} from './http'

interface ModelsPayload {
  data?: Array<string | { id?: string; name?: string }>
  models?: Array<string | { id?: string; name?: string }>
}

function modelId(item: string | { id?: string; name?: string }): string {
  if (typeof item === 'string') return item.trim()
  return (item.id || item.name || '').trim()
}

export async function fetchModelList(
  provider: ProviderConfig,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!provider.baseUrl) throw new ProviderError('bad_request', '服务商 Base URL 为空。')
  if (!apiKey) throw new ProviderError('auth', '没有填写 API Key。', { providerId: provider.id })
  const url = applyProxy(joinUrl(provider.baseUrl, '/models'), provider.proxyUrl)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
  } catch (err) {
    throw errorFromFetch(err, provider.id)
  }
  if (!res.ok) {
    const payload = await readErrorPayload(res)
    throw errorFromResponse(res, payload, provider.id)
  }
  let json: ModelsPayload
  try {
    json = (await res.json()) as ModelsPayload
  } catch {
    throw new ProviderError('bad_request', '服务商返回的模型列表不是 JSON。', {
      providerId: provider.id,
      status: res.status,
    })
  }
  const rows = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : []
  const ids = rows.map(modelId).filter(Boolean)
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}
