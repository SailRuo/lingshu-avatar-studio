import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { PlatformBridge } from './bridge'
import type {
  PlatformCharacterListRow,
  PlatformCharacterPayload,
  PlatformCharacterRecord,
  PlatformFormPart,
  PlatformHttpEvent,
  PlatformHttpRequest,
  PlatformSaveResult,
  FishLiveEvent,
  FishLiveStart,
} from '../../types/platform'

/**
 * The Tauri implementation of the platform bridge.
 *
 * The Platform build talked to its main process over IPC; this one talks to
 * the Rust backend over Tauri's `invoke` / `listen` channels. The renderer
 * only ever sees the `PlatformBridge` interface, so both builds share every
 * service.
 *
 * Three details of the Rust side shape this file:
 *
 * * `Vec<u8>` travels as a plain JSON number array, so every byte buffer is
 *   converted on the way in and on the way out. The `{"0": 1}` shape a
 *   `Uint8Array` turns into once it is stringified is *not* accepted by
 *   serde, it would make the whole command fail.
 * * The HTTP proxy has no `parts` field: a multipart body travels as JSON in
 *   `bodyText` and Rust rebuilds the multipart body — and its boundary —
 *   itself.
 * * `http:event` and `fish:event` are global events; the payload carries the
 *   request / session id, so one listener per kind is enough.
 */

/** True while the app runs inside a Tauri webview. */
export function inTauri(): boolean {
  try {
    if (isTauri()) return true
  } catch {
    // The helper is not available outside a Tauri webview.
  }
  const internals = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  return !!internals
}

type HttpListener = (event: PlatformHttpEvent) => void
type FishListener = (event: FishLiveEvent) => void

// ---------------------------------------------------------------- raw shapes

interface RawHttpEvent {
  type: 'meta' | 'chunk' | 'end' | 'error'
  id: string
  status?: number
  statusText?: string
  status_text?: string
  headers?: Record<string, string>
  chunk?: number[]
  name?: string
  message?: string
}

interface RawFishEvent {
  token: string
  type: 'ready' | 'audio' | 'finish' | 'error' | 'closed'
  data?: number[]
  reason?: string
  message?: string
  code?: number
}

interface RawCharacterBlob {
  mime: string
  data: number[]
}

interface RawCharacterLayer {
  id: string
  mime: string
  data: number[]
}

interface RawCharacterListRow {
  id: string
  name: string
  tier: string
  createdAt: number
  updatedAt: number
  thumbnail: number[] | null
  thumbnailMime: string | null
}

interface RawCharacterRecord {
  id: string
  name: string
  tier: string
  createdAt: number
  updatedAt: number
  manifest: unknown
  rig: unknown
  persona: unknown
  thumbnail: RawCharacterBlob | null
  layers: RawCharacterLayer[]
}

// ------------------------------------------------------------------ helpers

function toBytes(value: number[] | null | undefined): Uint8Array | null {
  if (!value) return null
  return new Uint8Array(value)
}

function toByteArray(bytes: Uint8Array | null | undefined): number[] {
  return bytes ? Array.from(bytes) : []
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

// ------------------------------------------------------------------ events

const httpListeners = new Set<HttpListener>()
const fishListeners = new Set<FishListener>()

let httpReady: Promise<void> | null = null
let fishReady: Promise<void> | null = null

function dispatchHttp(event: PlatformHttpEvent): void {
  for (const listener of [...httpListeners]) {
    try {
      listener(event)
    } catch {
      // A renderer listener must not break the channel.
    }
  }
}

function dispatchFish(event: FishLiveEvent): void {
  for (const listener of [...fishListeners]) {
    try {
      listener(event)
    } catch {
      // A renderer listener must not break the channel.
    }
  }
}

/**
 * Registers the single `http:event` listener.
 *
 * The promise resolves once the listener is live, so a request can never be
 * sent before the channel that answers it exists.
 */
function ensureHttpListener(): Promise<void> {
  if (!httpReady) {
    httpReady = listen<RawHttpEvent>('http:event', (event) => {
      dispatchHttp(normalizeHttpEvent(event.payload))
    })
      .then(() => undefined)
      .catch(() => undefined)
  }
  return httpReady
}

/** Registers the single `fish:event` listener. */
function ensureFishListener(): Promise<void> {
  if (!fishReady) {
    fishReady = listen<RawFishEvent>('fish:event', (event) => {
      dispatchFish(normalizeFishEvent(event.payload))
    })
      .then(() => undefined)
      .catch(() => undefined)
  }
  return fishReady
}

function normalizeHttpEvent(raw: RawHttpEvent): PlatformHttpEvent {
  switch (raw.type) {
    case 'meta':
      return {
        type: 'meta',
        id: raw.id,
        status: raw.status ?? 0,
        // Rust sends `statusText`; `status_text` is kept as a fallback.
        statusText: raw.statusText ?? raw.status_text ?? '',
        headers: raw.headers ?? {},
      }
    case 'chunk':
      return { type: 'chunk', id: raw.id, chunk: new Uint8Array(raw.chunk ?? []) }
    case 'end':
      return { type: 'end', id: raw.id }
    default:
      return {
        type: 'error',
        id: raw.id,
        name: raw.name,
        message: raw.message ?? 'HTTP 请求失败',
      }
  }
}

function normalizeFishEvent(raw: RawFishEvent): FishLiveEvent {
  switch (raw.type) {
    case 'ready':
      return { token: raw.token, type: 'ready' }
    case 'audio':
      return { token: raw.token, type: 'audio', data: new Uint8Array(raw.data ?? []) }
    case 'finish':
      return { token: raw.token, type: 'finish', reason: raw.reason ?? '' }
    case 'error':
      return { token: raw.token, type: 'error', message: raw.message ?? 'Fish Audio 合成失败。' }
    default:
      return {
        token: raw.token,
        type: 'closed',
        code: raw.code ?? 0,
        reason: raw.reason ?? '',
      }
  }
}

// -------------------------------------------------------------------- http

/** The multipart body Rust expects: the parts as JSON in `bodyText`. */
function encodeFormParts(parts: PlatformFormPart[]): string {
  return JSON.stringify(
    parts.map((part) => {
      const encoded: Record<string, unknown> = { name: part.name }
      if (part.value !== undefined) encoded.value = part.value
      if (part.filename !== undefined) encoded.filename = part.filename
      if (part.type !== undefined) encoded.type = part.type
      if (part.bytes) encoded.bytes = Array.from(part.bytes)
      return encoded
    }),
  )
}

function buildBody(payload: PlatformHttpRequest): Record<string, unknown> | undefined {
  if (payload.bodyType === 'text') {
    return { bodyType: 'text', bodyText: payload.bodyText ?? '' }
  }
  if (payload.bodyType === 'bytes') {
    return { bodyType: 'bytes', bodyBytes: toByteArray(payload.bodyBytes) }
  }
  if (payload.bodyType === 'formdata') {
    // Rust rebuilds the multipart body (and its boundary) from this JSON.
    return { bodyType: 'formdata', bodyText: encodeFormParts(payload.parts ?? []) }
  }
  return undefined
}

function buildHeaders(payload: PlatformHttpRequest): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(payload.headers ?? {})) {
    const name = rawName.trim().toLowerCase()
    if (!name) continue
    // The connection owns these two; sending them would corrupt the request.
    if (name === 'host' || name === 'content-length') continue
    headers[name] = value
  }
  if (payload.bodyType === 'formdata') {
    // Rust sets the multipart content type together with its boundary.
    delete headers['content-type']
  }
  return headers
}

function httpStart(payload: PlatformHttpRequest): void {
  const body = buildBody(payload)
  const args: Record<string, unknown> = {
    id: payload.id,
    url: payload.url,
    method: payload.method,
    headers: buildHeaders(payload),
  }
  if (body) args.body = body

  void ensureHttpListener()
    .then(() => invoke('http_start', args))
    .catch((error) => {
      // The request never left the renderer; report it like the proxy would.
      dispatchHttp({
        type: 'error',
        id: payload.id,
        name: 'TypeError',
        message: describeError(error),
      })
    })
}

function httpAbort(id: string): void {
  void invoke('http_abort', { id }).catch(() => {
    // The request may already be gone; nothing to report.
  })
}

function onHttpEvent(listener: HttpListener): () => void {
  httpListeners.add(listener)
  void ensureHttpListener()
  return () => {
    httpListeners.delete(listener)
  }
}

// -------------------------------------------------------------------- fish

function fishStart(payload: FishLiveStart): void {
  void ensureFishListener()
    .then(() =>
      // The Rust command takes the session as one `payload` argument; the
      // flat fields travel along so either shape of the command works.
      invoke('fish_start', { payload, ...payload }),
    )
    .catch((error) => {
      dispatchFish({ token: payload.token, type: 'error', message: describeError(error) })
    })
}

function fishCommand(command: string, token: string, extra?: { text?: string }): void {
  void invoke(command, extra ? { token, text: extra.text ?? '' } : { token }).catch((error) => {
    dispatchFish({ token, type: 'error', message: describeError(error) })
  })
}

// ------------------------------------------------------------------- bridge

export const tauriBridge: PlatformBridge = {
  // Read at call time: the same bundle also runs in a plain browser.
  get isTauri(): boolean {
    return inTauri()
  },

  httpStart,
  httpAbort,
  onHttpEvent,

  fish: {
    start: fishStart,
    text: (payload) => fishCommand('fish_text', payload.token, { text: payload.text }),
    flush: (payload) => fishCommand('fish_flush', payload.token),
    stop: (payload) => fishCommand('fish_stop', payload.token),
    cancel: (payload) => fishCommand('fish_cancel', payload.token),
    onEvent: (listener: FishListener) => {
      fishListeners.add(listener)
      void ensureFishListener()
      return () => {
        fishListeners.delete(listener)
      }
    },
  },

  keyVault: {
    set: (id, secret) => invoke<boolean>('keyvault_set', { id, secret }),
    get: (id) => invoke<string | null>('keyvault_get', { id }),
    delete: (id) => invoke<boolean>('keyvault_delete', { id }),
    clear: () => invoke<boolean>('keyvault_clear', {}),
    list: () => invoke<string[]>('keyvault_list', {}),
  },

  async saveFile(payload): Promise<PlatformSaveResult> {
    const args: Record<string, unknown> = {
      defaultName: payload.defaultName,
      bytes: toByteArray(payload.bytes),
    }
    if (payload.filters) args.filters = payload.filters
    const result = await invoke<{ saved: boolean; path?: string }>('file_save', args)
    return { saved: !!result.saved, path: result.path }
  },

  appInfo: () => invoke<{ version: string; platform: string }>('app_info', {}),

  db: {
    characters: {
      async list(): Promise<PlatformCharacterListRow[]> {
        const rows = await invoke<RawCharacterListRow[]>('db_characters_list', {})
        return rows.map((row) => ({
          id: row.id,
          name: row.name,
          tier: row.tier as PlatformCharacterListRow['tier'],
          updatedAt: row.updatedAt,
          thumbnail: toBytes(row.thumbnail),
          thumbnailMime: row.thumbnailMime ?? null,
        }))
      },
      async get(id: string): Promise<PlatformCharacterRecord | null> {
        const row = await invoke<RawCharacterRecord | null>('db_characters_get', { id })
        if (!row) return null
        return {
          id: row.id,
          name: row.name,
          tier: row.tier as PlatformCharacterRecord['tier'],
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          manifest: row.manifest as PlatformCharacterRecord['manifest'],
          rig: row.rig as PlatformCharacterRecord['rig'],
          persona: row.persona as PlatformCharacterRecord['persona'],
          thumbnail: row.thumbnail
            ? { mime: row.thumbnail.mime, data: new Uint8Array(row.thumbnail.data) }
            : null,
          layers: row.layers.map((layer) => ({
            id: layer.id,
            mime: layer.mime,
            data: new Uint8Array(layer.data),
          })),
        }
      },
      async save(payload: PlatformCharacterPayload): Promise<{ id: string; updatedAt: number }> {
        const result = await invoke<{ id: string; updatedAt: number }>('db_characters_save', {
          payload: {
            id: payload.id,
            name: payload.name,
            tier: payload.tier,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            manifest: payload.manifest,
            rig: payload.rig,
            persona: payload.persona,
            thumbnail: payload.thumbnail
              ? { mime: payload.thumbnail.mime, data: toByteArray(payload.thumbnail.data) }
              : null,
            layers: payload.layers.map((layer) => ({
              id: layer.id,
              mime: layer.mime,
              data: toByteArray(layer.data),
            })),
          },
        })
        return { id: result.id, updatedAt: result.updatedAt }
      },
      delete: (id: string) => invoke<boolean>('db_characters_delete', { id }),
    },
    settings: {
      get: (key: string) => invoke<string | null>('db_settings_get', { key }),
      set: (key: string, value: string) => invoke<boolean>('db_settings_set', { key, value }),
    },
    file: () => invoke<string>('db_file', {}),
  },
}
