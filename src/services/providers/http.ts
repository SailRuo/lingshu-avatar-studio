import { isNativeRuntime } from '../platform/bridge'

export type ProviderErrorKind =
  | 'cors'
  | 'auth'
  | 'rate_limit'
  | 'model'
  | 'network'
  | 'bad_request'
  | 'unsupported'
  | 'unknown'

export class ProviderError extends Error {
  kind: ProviderErrorKind
  status?: number
  providerId?: string
  retryable: boolean

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { status?: number; providerId?: string; retryable?: boolean } = {},
  ) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = options.status
    this.providerId = options.providerId
    this.retryable = options.retryable ?? false
  }
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.replace(/^\/+/, '')
  return `${base}/${suffix}`
}

export function applyProxy(url: string, proxyUrl?: string): string {
  if (!proxyUrl?.trim()) return url
  const proxy = proxyUrl.trim()
  if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(url))
  return `${proxy.replace(/\/+$/, '')}/${encodeURIComponent(url)}`
}

export function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

export async function readErrorPayload(res: Response): Promise<{ message: string; raw: unknown }> {
  const text = await res.text().catch(() => '')
  if (!text) return { message: res.statusText || `HTTP ${res.status}`, raw: null }
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    const error = json.error as Record<string, unknown> | string | undefined
    if (typeof error === 'string') return { message: error, raw: json }
    if (error && typeof error === 'object') {
      const message = error.message
      if (typeof message === 'string') return { message, raw: json }
    }
    const message = json.message
    if (typeof message === 'string') return { message, raw: json }
    return { message: text.slice(0, 500), raw: json }
  } catch {
    return { message: text.slice(0, 500), raw: text }
  }
}

export function errorFromResponse(
  res: Response,
  payload: { message: string },
  providerId?: string,
): ProviderError {
  const status = res.status
  const lower = payload.message.toLowerCase()
  if (status === 401 || status === 403) {
    return new ProviderError('auth', payload.message, { status, providerId })
  }
  if (status === 429) {
    return new ProviderError('rate_limit', payload.message, { status, providerId, retryable: true })
  }
  if (status === 404 || (status === 400 && /model|voice|not found|does not exist/.test(lower))) {
    return new ProviderError('model', payload.message, { status, providerId })
  }
  if (status >= 500) {
    return new ProviderError('network', payload.message, { status, providerId, retryable: true })
  }
  return new ProviderError('bad_request', payload.message, { status, providerId })
}

export function errorFromFetch(err: unknown, providerId?: string): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ProviderError('network', '请求已取消', { providerId })
  }
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)) {
    const online = typeof navigator === 'undefined' ? true : navigator.onLine
    if (online) {
      if (isNativeRuntime()) {
        return new ProviderError(
          'network',
          '本机网络请求失败，请检查网络、Base URL 或服务商状态。',
          { providerId, retryable: true },
        )
      }
      return new ProviderError(
        'cors',
        '浏览器被服务商的跨域策略或网络拦截（不一定是密钥错误）。可以换用支持 CORS 的服务商，或在高级设置里配置你自己的代理。',
        { providerId, retryable: true },
      )
    }
    return new ProviderError('network', '网络不可用，请检查连接。', { providerId, retryable: true })
  }
  return new ProviderError('unknown', message, { providerId })
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit,
  providerId?: string,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    throw errorFromFetch(err, providerId)
  }
  if (!res.ok) {
    const payload = await readErrorPayload(res)
    throw errorFromResponse(res, payload, providerId)
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new ProviderError('bad_request', '服务商返回了无法解析的 JSON。', {
      status: res.status,
      providerId,
    })
  }
}

export function userMessageForError(err: unknown): string {
  if (err instanceof ProviderError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
