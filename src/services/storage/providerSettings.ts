import type { ProviderConfig, ProviderRole, RoleBindings } from '../../types/provider'
import { getPlatform, isNativeRuntime } from '../platform/bridge'

const LEGACY_STORAGE_KEY = 'lingshu-avatar-studio.providers.v1'
const SQLITE_SETTING_KEY = 'providers'

export interface PersistedProviderSettings {
  providers?: ProviderConfig[]
  bindings?: RoleBindings
  roleModels?: Partial<Record<ProviderRole, string>>
  /** Voice id per provider id. */
  roleVoices?: Record<string, string>
  /** Legacy single voice for the TTS role. */
  roleVoice?: string
}

/**
 * The native settings table.
 *
 * `undefined` in a plain browser: there the local storage below is used
 * instead.
 */
function nativeDatabase() {
  if (!isNativeRuntime()) return undefined
  return getPlatform().db
}

function parseSettings(raw: string | null): PersistedProviderSettings | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as PersistedProviderSettings
  } catch {
    return null
  }
}

export async function loadProviderSettings(): Promise<PersistedProviderSettings | null> {
  const database = nativeDatabase()
  if (database) {
    const stored = parseSettings(await database.settings.get(SQLITE_SETTING_KEY))
    if (stored) return stored
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY)
    const legacy = parseSettings(legacyRaw)
    if (legacy && legacyRaw) {
      await database.settings.set(SQLITE_SETTING_KEY, legacyRaw)
      localStorage.removeItem(LEGACY_STORAGE_KEY)
      return legacy
    }
    return null
  }
  return parseSettings(localStorage.getItem(LEGACY_STORAGE_KEY))
}

export async function saveProviderSettings(serialized: string): Promise<void> {
  const database = nativeDatabase()
  if (database) {
    await database.settings.set(SQLITE_SETTING_KEY, serialized)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    return
  }
  localStorage.setItem(LEGACY_STORAGE_KEY, serialized)
}
