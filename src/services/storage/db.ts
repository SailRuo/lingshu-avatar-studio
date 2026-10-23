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

interface StoredModel {
  id: string
  blob: Blob
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
  models: {
    key: string
    value: StoredModel
  }
}

const DB_NAME = 'lingshu-avatar-studio'
// v2 added the optional local model store. The upgrade callback only creates
// the new store, so existing characters and keys are left untouched.
const DB_VERSION = 2

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
        if (!db.objectStoreNames.contains('models')) {
          db.createObjectStore('models', { keyPath: 'id' })
        }
      },
    })
  }
  return dbPromise
}
