import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { CharacterRecord } from '../../types/character'

interface StoredKey {
  id: string
  secret: string
  updatedAt: number
}

interface StoredSetting {
  key: string
  value: unknown
}

interface AvatarDB extends DBSchema {
  characters: {
    key: string
    value: CharacterRecord
    indexes: { 'by-updated': number }
  }
  keys: {
    key: string
    value: StoredKey
  }
  settings: {
    key: string
    value: StoredSetting
  }
}

const DB_NAME = 'lingshu-avatar-studio'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<AvatarDB>> | null = null

export function getDb(): Promise<IDBPDatabase<AvatarDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AvatarDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('characters')) {
          const store = db.createObjectStore('characters', { keyPath: 'id' })
          store.createIndex('by-updated', 'updatedAt')
        }
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' })
        }
      },
    })
  }
  return dbPromise
}
