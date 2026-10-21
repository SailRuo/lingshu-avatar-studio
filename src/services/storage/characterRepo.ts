import type { CharacterMeta, CharacterRecord } from '../../types/character'
import { getPlatform, isNativeRuntime } from '../platform/bridge'
import { getDb } from './db'
import {
  fromStoredCharacter,
  migrateCharacterRecord,
  toStoredCharacter,
  toPlainCharacter,
} from './recordTransfer'

/**
 * The native character database.
 *
 * `undefined` in a plain browser: there the IndexedDB store below is used
 * instead.
 */
function nativeDatabase() {
  if (!isNativeRuntime()) return undefined
  return getPlatform().db
}

function thumbnailUrl(data: Uint8Array, mime: string | null): string {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return URL.createObjectURL(new Blob([copy.buffer], { type: mime || 'image/png' }))
}

export const characterRepo = {
  async save(record: CharacterRecord): Promise<void> {
    const database = nativeDatabase()
    if (database) {
      await database.characters.save(await toStoredCharacter(record))
      return
    }
    const db = await getDb()
    await db.put('characters', { ...toPlainCharacter(record), updatedAt: Date.now() })
  },

  async list(): Promise<CharacterRecord[]> {
    const db = await getDb()
    const rows = await db.getAllFromIndex('characters', 'by-updated')
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)
  },

  async listMeta(): Promise<CharacterMeta[]> {
    const database = nativeDatabase()
    if (database) {
      const rows = await database.characters.list()
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        tier: row.tier,
        updatedAt: row.updatedAt,
        thumbnailUrl: row.thumbnail
          ? thumbnailUrl(row.thumbnail, row.thumbnailMime)
          : undefined,
      }))
    }
    const records = await this.list()
    return records.map((record) => this.toMeta(record))
  },

  async get(id: string): Promise<CharacterRecord | undefined> {
    const database = nativeDatabase()
    if (database) {
      const row = await database.characters.get(id)
      return row ? migrateCharacterRecord(fromStoredCharacter(row)) : undefined
    }
    const db = await getDb()
    const record = await db.get('characters', id)
    return record ? migrateCharacterRecord(record) : undefined
  },

  async delete(id: string): Promise<void> {
    const database = nativeDatabase()
    if (database) {
      await database.characters.delete(id)
      return
    }
    const db = await getDb()
    await db.delete('characters', id)
  },

  toMeta(record: CharacterRecord): CharacterMeta {
    return {
      id: record.id,
      name: record.name,
      tier: record.manifest.tier,
      updatedAt: record.updatedAt,
      thumbnailUrl: record.thumbnail ? URL.createObjectURL(record.thumbnail) : undefined,
    }
  },
}

export async function migrateLegacyCharacters(): Promise<number> {
  const database = nativeDatabase()
  if (!database) return 0
  if ((await database.characters.list()).length) return 0
  const db = await getDb()
  const legacy = await db.getAll('characters')
  if (!legacy.length) return 0
  for (const record of legacy) {
    await database.characters.save(await toStoredCharacter(record))
  }
  const tx = db.transaction('characters', 'readwrite')
  await tx.store.clear()
  await tx.done
  return legacy.length
}
