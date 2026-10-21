import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { CharacterMeta, CharacterRecord } from '../types/character'
import { characterRepo } from '../services/storage/characterRepo'

export const useCharacterStore = defineStore('characters', () => {
  const characters = ref<CharacterMeta[]>([])
  const loading = ref(false)
  const thumbnailUrls: Record<string, string> = {}

  async function load() {
    loading.value = true
    try {
      const metas = await characterRepo.listMeta()
      for (const url of Object.values(thumbnailUrls)) URL.revokeObjectURL(url)
      for (const key of Object.keys(thumbnailUrls)) delete thumbnailUrls[key]
      characters.value = metas.map((meta) => {
        if (meta.thumbnailUrl) thumbnailUrls[meta.id] = meta.thumbnailUrl
        return meta
      })
    } finally {
      loading.value = false
    }
  }

  async function get(id: string): Promise<CharacterRecord | undefined> {
    return characterRepo.get(id)
  }

  async function save(record: CharacterRecord) {
    await characterRepo.save(record)
    await load()
  }

  async function remove(id: string) {
    await characterRepo.delete(id)
    if (thumbnailUrls[id]) {
      URL.revokeObjectURL(thumbnailUrls[id])
      delete thumbnailUrls[id]
    }
    await load()
  }

  return { characters, loading, load, get, save, remove }
})
