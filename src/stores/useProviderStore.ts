import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ProviderConfig, ProviderRole, RoleBindings } from '../types/provider'
import { BUILTIN_PROVIDERS, createCustomProvider, suggestedModels } from '../services/providers/catalog'
import { providerNeedsUserProxy } from '../services/platform/runtime'
import { fetchModelList } from '../services/providers/models'
import { keyVault } from '../services/storage/keyVault'
import {
  loadProviderSettings,
  saveProviderSettings,
  type PersistedProviderSettings,
} from '../services/storage/providerSettings'

type RoleModels = Partial<Record<ProviderRole, string>>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mergeProviders(saved: ProviderConfig[]): ProviderConfig[] {
  const byId = new Map(saved.map((provider) => [provider.id, provider]))
  const merged: ProviderConfig[] = []
  for (const builtin of BUILTIN_PROVIDERS) {
    const existing = byId.get(builtin.id)
    if (existing) {
      const legacyModels = existing.models as ProviderConfig['models'] & {
        vision?: string
        imageEdit?: string
      }
      merged.push({
        ...builtin,
        ...existing,
        models: {
          image: existing.models.image ?? legacyModels.imageEdit ?? builtin.models.image,
          chat: existing.models.chat ?? legacyModels.vision ?? builtin.models.chat,
          tts: existing.models.tts ?? builtin.models.tts,
        },
        capabilities: builtin.capabilities,
        supportsEdit: builtin.supportsEdit,
        builtin: true,
      })
      byId.delete(builtin.id)
    } else {
      merged.push({ ...builtin })
    }
  }
  for (const provider of byId.values()) {
    // Older builds shipped DeepSeek as a text-only chat option. It cannot see images,
    // so do not let it re-enter the multimodal agent binding.
    if (provider.id === 'deepseek') continue
    merged.push(provider)
  }
  return merged
}

export const useProviderStore = defineStore('providers', () => {
  const providers = ref<ProviderConfig[]>([...BUILTIN_PROVIDERS])
  const bindings = ref<RoleBindings>({})
  const roleModels = ref<RoleModels>({})
  /** Voice id per provider: a Fish reference id must not leak into another TTS. */
  const roleVoices = ref<Record<string, string>>({})
  const keyPresence = ref<Record<string, boolean>>({})
  const modelLists = ref<Record<string, string[]>>({})
  const modelLoading = ref<Record<string, boolean>>({})
  const modelErrors = ref<Record<string, string>>({})
  const refreshing = ref(false)
  const hydrated = ref(false)
  let hydratePromise: Promise<void> | null = null
  let writeQueue: Promise<void> = Promise.resolve()

  const readyCount = computed(
    () => providers.value.filter((provider) => keyPresence.value[provider.id]).length,
  )

  function applyPersistedSettings(parsed: PersistedProviderSettings) {
    const saved = Array.isArray(parsed.providers) ? parsed.providers : []
    const merged = mergeProviders(saved)
    const legacyBindings = (parsed.bindings ?? {}) as RoleBindings & { vision?: string }
    const mergedBindings: RoleBindings = { ...legacyBindings }
    if (!mergedBindings.chat && legacyBindings.vision) mergedBindings.chat = legacyBindings.vision
    delete (mergedBindings as RoleBindings & { vision?: string }).vision
    providers.value = merged
    bindings.value = mergedBindings
    roleModels.value = parsed.roleModels ?? {}
    roleVoices.value = parsed.roleVoices ?? {}
    if (!Object.keys(roleVoices.value).length && parsed.roleVoice) {
      // Older builds stored a single voice for the TTS role; keep it for the
      // provider bound to it now.
      const bound = mergedBindings.tts
      if (bound) roleVoices.value = { [bound]: parsed.roleVoice }
    }
  }

  async function hydrate(): Promise<void> {
    if (hydrated.value) return
    if (hydratePromise) return hydratePromise
    hydratePromise = (async () => {
      try {
        const parsed = await loadProviderSettings()
        if (parsed) applyPersistedSettings(parsed)
      } catch (error) {
        console.warn('[avatar] failed to load provider settings', error)
      } finally {
        hydrated.value = true
        try {
          await keyVault.migrateLegacyBrowserKeys()
        } catch {
          // Key migration failures must not block the app from starting.
        }
        try {
          await refreshKeyPresence()
        } catch (error) {
          console.warn('[avatar] failed to read key presence', error)
        }
        // A voice provider that already owns a key takes over the voice role,
        // so an existing setup starts speaking instead of staying silent.
        adoptVoiceProvider()
        hydratePromise = null
      }
    })()
    return hydratePromise
  }

  function persist() {
    if (!hydrated.value) return
    const serialized = JSON.stringify({
      providers: providers.value,
      bindings: bindings.value,
      roleModels: roleModels.value,
      roleVoices: roleVoices.value,
    })
    writeQueue = writeQueue
      .then(() => saveProviderSettings(serialized))
      .catch((error) => console.warn('[avatar] failed to save provider settings', error))
  }

  function providerById(id: string | undefined): ProviderConfig | undefined {
    if (!id) return undefined
    return providers.value.find((provider) => provider.id === id)
  }

  function roleProvider(role: ProviderRole): ProviderConfig | undefined {
    return providerById(bindings.value[role])
  }

  function defaultModelFor(role: ProviderRole, provider: ProviderConfig | undefined): string {
    if (!provider) return ''
    if (role === 'image') return provider.models.image ?? ''
    if (role === 'chat') return provider.models.chat ?? ''
    return provider.models.tts ?? ''
  }

  function roleModel(role: ProviderRole): string {
    const explicit = roleModels.value[role]?.trim()
    if (explicit) return explicit
    return defaultModelFor(role, roleProvider(role))
  }

  function setRoleModel(role: ProviderRole, model: string) {
    const trimmed = model.trim()
    if (trimmed) roleModels.value[role] = trimmed
    else delete roleModels.value[role]
    roleModels.value = { ...roleModels.value }
    persist()
  }

  function roleVoiceValue(): string {
    const provider = roleProvider('tts')
    if (!provider) return ''
    const explicit = (roleVoices.value[provider.id] ?? '').trim()
    if (explicit) return explicit
    // Fish stores its voice as a model id, so it has to be part of the chain
    // or the role card would show an empty voice while a valid one is set.
    return (
      provider.extra.defaultVoice ??
      provider.extra.voiceId ??
      provider.extra.referenceId ??
      ''
    )
  }

  function setRoleVoice(voice: string, providerId?: string) {
    const id = providerId ?? roleProvider('tts')?.id
    if (!id) return
    const trimmed = voice.trim()
    const next = { ...roleVoices.value }
    if (trimmed) next[id] = trimmed
    else delete next[id]
    roleVoices.value = next
    persist()
  }

  async function refreshKeyPresence() {
    refreshing.value = true
    try {
      const next: Record<string, boolean> = {}
      await Promise.all(
        providers.value.map(async (provider) => {
          next[provider.id] = await keyVault.hasKey(provider.id)
        }),
      )
      keyPresence.value = next
    } finally {
      refreshing.value = false
    }
  }

  function updateProvider(id: string, patch: Partial<ProviderConfig>) {
    const index = providers.value.findIndex((provider) => provider.id === id)
    if (index < 0) return
    providers.value[index] = { ...providers.value[index], ...patch }
    providers.value = [...providers.value]
    delete modelLists.value[id]
    delete modelErrors.value[id]
    persist()
  }

  function addCustomProvider(config?: Partial<ProviderConfig>): ProviderConfig {
    const base = createCustomProvider()
    const provider: ProviderConfig = {
      ...base,
      ...config,
      id: config?.id || base.id,
      kind: 'openai-compatible',
      builtin: false,
    }
    providers.value = [...providers.value, provider]
    persist()
    return provider
  }

  function removeProvider(id: string) {
    const provider = providerById(id)
    if (!provider || provider.builtin) return
    providers.value = providers.value.filter((item) => item.id !== id)
    for (const role of Object.keys(bindings.value) as ProviderRole[]) {
      if (bindings.value[role] === id) {
        delete bindings.value[role]
        delete roleModels.value[role]
      }
    }
    bindings.value = { ...bindings.value }
    roleModels.value = { ...roleModels.value }
    const voices = { ...roleVoices.value }
    delete voices[id]
    roleVoices.value = voices
    delete modelLists.value[id]
    delete modelErrors.value[id]
    persist()
  }

  /**
   * A voice provider that owns a key becomes the voice provider, as long as
   * nothing else was chosen. Without this, configuring Fish and then chatting
   * produces silence because the TTS role was never bound.
   */
  function adoptVoiceProvider() {
    if (bindings.value.tts) return
    const candidates = providers.value.filter(
      (provider) =>
        provider.capabilities.includes('tts') &&
        !!keyPresence.value[provider.id] &&
        !!provider.baseUrl,
    )
    if (candidates.length !== 1) return
    setBinding('tts', candidates[0].id)
  }

  async function saveKey(providerId: string, secret: string, sessionOnly = false) {
    await keyVault.setKey(providerId, secret, sessionOnly)
    delete modelLists.value[providerId]
    delete modelErrors.value[providerId]
    await refreshKeyPresence()
    adoptVoiceProvider()
  }

  async function deleteKey(providerId: string) {
    await keyVault.deleteKey(providerId)
    delete modelLists.value[providerId]
    delete modelErrors.value[providerId]
    await refreshKeyPresence()
  }

  async function getKey(providerId: string): Promise<string | undefined> {
    return keyVault.getKey(providerId)
  }

  function setBinding(role: ProviderRole, providerId: string | undefined) {
    const changed = bindings.value[role] !== providerId
    if (providerId) bindings.value[role] = providerId
    else delete bindings.value[role]
    if (changed) {
      delete roleModels.value[role]
    }
    bindings.value = { ...bindings.value }
    roleModels.value = { ...roleModels.value }
    persist()
  }

  async function loadModels(providerId: string, force = false): Promise<string[]> {
    if (!providerId) return []
    const provider = providerById(providerId)
    if (!provider) return []
    if (!force && modelLists.value[providerId]) return modelLists.value[providerId]
    if (modelLoading.value[providerId]) return modelLists.value[providerId] ?? []

    const apiKey = (await keyVault.getKey(providerId)) ?? ''
    if (!apiKey) {
      modelErrors.value = { ...modelErrors.value, [providerId]: '该服务商还没有保存 Key。' }
      return []
    }
    if (provider.kind === 'fishaudio') {
      // Fish has no /models endpoint; offer the known models instead.
      const ids = suggestedModels(provider)
      modelLists.value = { ...modelLists.value, [providerId]: ids }
      return ids
    }
    if (providerNeedsUserProxy(provider)) {
      modelErrors.value = {
        ...modelErrors.value,
        [providerId]: '网页版需要自备代理，才能获取模型列表。',
      }
      return []
    }

    modelLoading.value = { ...modelLoading.value, [providerId]: true }
    try {
      const models = await fetchModelList(provider, apiKey)
      modelLists.value = { ...modelLists.value, [providerId]: models }
      if (models.length) {
        const nextErrors = { ...modelErrors.value }
        delete nextErrors[providerId]
        modelErrors.value = nextErrors
      } else {
        modelErrors.value = {
          ...modelErrors.value,
          [providerId]: '服务商没有返回模型列表，可直接手动填写模型 ID。',
        }
      }
      return models
    } catch (error) {
      modelErrors.value = {
        ...modelErrors.value,
        [providerId]: `${errorText(error)} 可直接手动填写模型 ID。`,
      }
      return []
    } finally {
      modelLoading.value = { ...modelLoading.value, [providerId]: false }
    }
  }

  async function clearAllKeys() {
    await keyVault.clearAll()
    modelLists.value = {}
    modelErrors.value = {}
    await refreshKeyPresence()
  }

  function hasKey(providerId: string): boolean {
    return !!keyPresence.value[providerId]
  }

  function isRoleReady(role: ProviderRole): boolean {
    const provider = roleProvider(role)
    if (!provider || !hasKey(provider.id) || !provider.baseUrl) return false
    if (providerNeedsUserProxy(provider)) return false
    return !!roleModel(role)
  }

  return {
    providers,
    bindings,
    roleModels,
    roleVoices,
    keyPresence,
    modelLists,
    modelLoading,
    modelErrors,
    refreshing,
    hydrated,
    readyCount,
    hydrate,
    providerById,
    roleProvider,
    roleModel,
    setRoleModel,
    roleVoiceValue,
    setRoleVoice,
    refreshKeyPresence,
    updateProvider,
    addCustomProvider,
    removeProvider,
    saveKey,
    deleteKey,
    getKey,
    setBinding,
    loadModels,
    clearAllKeys,
    hasKey,
    isRoleReady,
  }
})
