import { tauriBridge } from './tauriBridge'
import type {
  PlatformCharacterListRow,
  PlatformCharacterPayload,
  PlatformCharacterRecord,
  PlatformHttpEvent,
  PlatformHttpRequest,
  PlatformSaveResult,
  FishLiveEvent,
  FishLiveStart,
} from '../../types/platform'

/**
 * The bridge between the renderer and the native layer.
 *
 * The Tauri backend is reached over `invoke` commands; the renderer code (the
 * character store, the key vault, the TTS clients) only ever sees this
 * interface.
 */
export interface PlatformBridge {
  /** True when the Tauri backend is behind the bridge. */
  isTauri: boolean
  /** Streaming HTTP proxy, used to reach providers that block browser CORS. */
  httpStart(payload: PlatformHttpRequest): void
  httpAbort(id: string): void
  onHttpEvent(listener: (event: PlatformHttpEvent) => void): () => void
  /** Live TTS sessions (Fish Audio). */
  fish: {
    start(payload: FishLiveStart): void
    text(payload: { token: string; text: string }): void
    flush(payload: { token: string }): void
    stop(payload: { token: string }): void
    cancel(payload: { token: string }): void
    onEvent(listener: (event: FishLiveEvent) => void): () => void
  }
  /** OS keychain for the provider API keys. */
  keyVault: {
    set(id: string, secret: string): Promise<boolean>
    get(id: string): Promise<string | null>
    delete(id: string): Promise<boolean>
    clear(): Promise<boolean>
    list(): Promise<string[]>
  }
  saveFile(payload: {
    defaultName: string
    filters?: Array<{ name: string; extensions: string[] }>
    bytes: Uint8Array
  }): Promise<PlatformSaveResult>
  appInfo(): Promise<{ version: string; platform: string }>
  /** The local character database. */
  db: {
    characters: {
      list(): Promise<PlatformCharacterListRow[]>
      get(id: string): Promise<PlatformCharacterRecord | null>
      save(payload: PlatformCharacterPayload): Promise<{ id: string; updatedAt: number }>
      delete(id: string): Promise<boolean>
    }
    settings: {
      get(key: string): Promise<string | null>
      set(key: string, value: string): Promise<boolean>
    }
    file(): Promise<string>
  }
}

let cached: PlatformBridge | null = null

/** The active bridge. */
export function getPlatform(): PlatformBridge {
  if (cached) return cached
  cached = tauriBridge
  return cached
}

/**
 * True when the app runs on a native backend that can reach any provider
 * without browser CORS limits.
 */
export function isNativeRuntime(): boolean {
  return getPlatform().isTauri
}
