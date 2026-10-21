import type {
  PlatformFormPart,
  PlatformHttpEvent,
  PlatformHttpMeta,
  PlatformHttpRequest,
} from '../../types/platform'
import { getPlatform, isNativeRuntime } from '../platform/bridge'

interface PendingRequest {
  controller: ReadableStreamDefaultController<Uint8Array>
  resolveMeta: (meta: PlatformHttpMeta) => void
  rejectMeta: (error: Error) => void
  cleanup: () => void
}

interface SerializedBody {
  bodyType?: 'text' | 'bytes' | 'formdata'
  bodyText?: string
  bodyBytes?: Uint8Array
  parts?: PlatformFormPart[]
}

let installed = false
const pending = new Map<string, PendingRequest>()

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function eventError(event: Extract<PlatformHttpEvent, { type: 'error' }>): Error {
  const error = new Error(event.message || '本机 HTTP 桥接失败')
  error.name = event.name || 'Error'
  return error
}

async function serializeBody(body: BodyInit | null | undefined): Promise<SerializedBody> {
  if (body == null) return {}
  if (typeof body === 'string') return { bodyType: 'text', bodyText: body }
  if (body instanceof URLSearchParams) return { bodyType: 'text', bodyText: body.toString() }
  if (body instanceof FormData) {
    const parts: PlatformFormPart[] = []
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') {
        parts.push({ name, value })
      } else {
        parts.push({
          name,
          filename: value.name,
          type: value.type,
          bytes: new Uint8Array(await value.arrayBuffer()),
        })
      }
    }
    return { bodyType: 'formdata', parts }
  }
  if (body instanceof Blob) {
    return { bodyType: 'bytes', bodyBytes: new Uint8Array(await body.arrayBuffer()) }
  }
  if (body instanceof ArrayBuffer) {
    return { bodyType: 'bytes', bodyBytes: new Uint8Array(body) }
  }
  if (ArrayBuffer.isView(body)) {
    return {
      bodyType: 'bytes',
      bodyBytes: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength),
    }
  }
  throw new Error('本机 HTTP 桥接不支持这种请求体。')
}

function requestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `req_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

/**
 * Routes every cross-origin request through the native HTTP bridge.
 *
 * The bridge is the only way out of the browser sandbox on a desktop build:
 * it reaches the providers without CORS limits and without a proxy. In a
 * plain browser the shim is not installed and the normal `fetch` is used.
 */
export function installNativeFetch(): void {
  if (typeof window === 'undefined') return
  if (!isNativeRuntime() || installed) return
  installed = true

  const platform = getPlatform()
  const originalFetch = window.fetch.bind(window)

  platform.onHttpEvent((event) => {
    const request = pending.get(event.id)
    if (!request) return
    if (event.type === 'meta') {
      request.resolveMeta(event)
      return
    }
    if (event.type === 'chunk') {
      try {
        request.controller.enqueue(new Uint8Array(event.chunk))
      } catch {
        // The consumer may have cancelled the stream.
      }
      return
    }
    if (event.type === 'end') {
      try {
        request.controller.close()
      } catch {
        // Already closed/cancelled.
      }
      request.cleanup()
      pending.delete(event.id)
      return
    }
    const error = eventError(event)
    try {
      request.controller.error(error)
    } catch {
      // Already closed/cancelled.
    }
    request.rejectMeta(error)
    request.cleanup()
    pending.delete(event.id)
  })

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const source = input instanceof Request ? input : null
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    let parsed: URL
    try {
      parsed = new URL(url, window.location.href)
    } catch {
      return originalFetch(input, init)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return originalFetch(input, init)
    }
    if (parsed.origin === window.location.origin) {
      return originalFetch(input, init)
    }

    const id = requestId()
    const method = init?.method || source?.method || 'GET'
    const headers = new Headers(init?.headers || source?.headers || undefined)
    const body = init?.body ?? (source ? await source.clone().arrayBuffer() : undefined)
    const serialized = await serializeBody(body as BodyInit | null | undefined)
    if (serialized.bodyType === 'formdata') headers.delete('content-type')

    const headerObject: Record<string, string> = {}
    headers.forEach((value, key) => {
      headerObject[key] = value
    })

    let controllerRef!: ReadableStreamDefaultController<Uint8Array>
    let resolveMeta!: (meta: PlatformHttpMeta) => void
    let rejectMeta!: (error: Error) => void
    const metaPromise = new Promise<PlatformHttpMeta>((resolve, reject) => {
      resolveMeta = resolve
      rejectMeta = reject
    })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller
      },
      cancel() {
        platform.httpAbort(id)
        pending.delete(id)
      },
    })

    let cleanup = () => {}
    const onAbort = () => {
      platform.httpAbort(id)
      const error = abortError()
      try {
        controllerRef.error(error)
      } catch {
        // Already closed.
      }
      rejectMeta(error)
      cleanup()
      pending.delete(id)
    }
    cleanup = () => init?.signal?.removeEventListener('abort', onAbort)
    pending.set(id, { controller: controllerRef, resolveMeta, rejectMeta, cleanup })

    if (init?.signal?.aborted) {
      onAbort()
      throw abortError()
    }
    init?.signal?.addEventListener('abort', onAbort, { once: true })

    const payload: PlatformHttpRequest = {
      id,
      url: parsed.toString(),
      method,
      headers: headerObject,
      ...serialized,
    }
    platform.httpStart(payload)

    let meta: PlatformHttpMeta
    try {
      meta = await metaPromise
    } catch (error) {
      cleanup()
      throw error
    }

    if (meta.status === 204 || meta.status === 304) {
      try {
        controllerRef.close()
      } catch {
        // ignore
      }
      cleanup()
      pending.delete(id)
      return new Response(null, {
        status: meta.status,
        statusText: meta.statusText,
        headers: meta.headers,
      })
    }

    return new Response(stream, {
      status: meta.status,
      statusText: meta.statusText,
      headers: meta.headers,
    })
  }
}
