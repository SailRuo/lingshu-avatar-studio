import type { ProviderConfig } from '../../types/provider'
import {
  applyProxy,
  errorFromFetch,
  errorFromResponse,
  fetchJson,
  joinUrl,
  readErrorPayload,
  ProviderError,
} from './http'

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface ChatOptions {
  provider: ProviderConfig
  apiKey: string
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  stream?: boolean
  onDelta?: (text: string) => void
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: unknown }
    delta?: { content?: unknown }
    finish_reason?: string
  }>
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

function requestUrl(provider: ProviderConfig, path: string): string {
  return applyProxy(joinUrl(provider.baseUrl, path), provider.proxyUrl)
}

function requestBody(options: ChatOptions, stream: boolean) {
  return {
    model: options.model,
    messages: options.messages,
    stream,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
  }
}

export async function streamChat(options: ChatOptions): Promise<string> {
  if (!options.provider.baseUrl) throw new ProviderError('bad_request', '服务商 Base URL 为空。')
  if (!options.model) throw new ProviderError('bad_request', '没有填写模型 ID。')
  const url = requestUrl(options.provider, '/chat/completions')
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody(options, true)),
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
    const json = (await res.json()) as ChatCompletionResponse
    const text = contentToText(json.choices?.[0]?.message?.content)
    if (text) options.onDelta?.(text)
    return text
  }
  if (!res.body) throw new ProviderError('bad_request', '服务商没有返回可读的流。')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let done = false

  while (!done) {
    const { value, done: streamDone } = await reader.read()
    if (streamDone) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      if (data === '[DONE]') {
        done = true
        break
      }
      try {
        const json = JSON.parse(data) as ChatCompletionResponse
        const choice = json.choices?.[0]
        const delta = contentToText(choice?.delta?.content ?? choice?.message?.content)
        if (delta) {
          full += delta
          options.onDelta?.(delta)
        }
      } catch {
        // Some providers emit non-JSON keepalive lines inside data:.
      }
    }
  }
  return full
}

export async function chatOnce(
  options: Omit<ChatOptions, 'stream' | 'onDelta'>,
): Promise<string> {
  if (!options.provider.baseUrl) throw new ProviderError('bad_request', '服务商 Base URL 为空。')
  if (!options.model) throw new ProviderError('bad_request', '没有填写模型 ID。')
  const url = requestUrl(options.provider, '/chat/completions')
  const json = await fetchJson<ChatCompletionResponse>(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody(options, false)),
      signal: options.signal,
    },
    options.provider.id,
  )
  return contentToText(json.choices?.[0]?.message?.content)
}

export function imagePart(dataUrl: string): ChatContentPart {
  return { type: 'image_url', image_url: { url: dataUrl } }
}

export function textPart(text: string): ChatContentPart {
  return { type: 'text', text }
}

export function stripJsonFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return (fenced ? fenced[1] : trimmed).trim()
}
