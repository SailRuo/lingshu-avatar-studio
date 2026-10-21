import { getPlatform, isNativeRuntime } from '../platform/bridge'
import { getDb } from './db'

const sessionKeys = new Map<string, string>()

/**
 * The native key vault (the OS keychain).
 *
 * `undefined` in a plain browser: there the IndexedDB store below is used
 * instead.
 */
function nativeKeyVault() {
  if (!isNativeRuntime()) return undefined
  return getPlatform().keyVault
}

async function readIndexedDb(id: string): Promise<string | undefined> {
  const db = await getDb()
  const row = await db.get('keys', id)
  return row?.secret
}

async function deleteIndexedDb(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('keys', id)
}

export const keyVault = {
  async setKey(id: string, secret: string, sessionOnly = false): Promise<void> {
    const trimmed = secret.trim()
    if (!trimmed) {
      await this.deleteKey(id)
      return
    }
    if (sessionOnly) {
      sessionKeys.set(id, trimmed)
      const vault = nativeKeyVault()
      if (vault) {
        try {
          await vault.delete(id)
        } catch {
          // Ignore cleanup failures; the in-memory key is what matters now.
        }
      }
      await deleteIndexedDb(id)
      return
    }
    sessionKeys.delete(id)
    const vault = nativeKeyVault()
    if (vault) {
      await vault.set(id, trimmed)
      return
    }
    const db = await getDb()
    await db.put('keys', { id, secret: trimmed, updatedAt: Date.now() })
  },

  async getKey(id: string): Promise<string | undefined> {
    const session = sessionKeys.get(id)
    if (session) return session
    const vault = nativeKeyVault()
    if (vault) {
      return (await vault.get(id)) ?? undefined
    }
    return readIndexedDb(id)
  },

  async hasKey(id: string): Promise<boolean> {
    if (sessionKeys.has(id)) return true
    const vault = nativeKeyVault()
    if (vault) {
      return !!(await vault.get(id))
    }
    return !!(await readIndexedDb(id))
  },

  async deleteKey(id: string): Promise<void> {
    sessionKeys.delete(id)
    const vault = nativeKeyVault()
    if (vault) {
      try {
        await vault.delete(id)
      } catch {
        // Continue with the browser-store cleanup.
      }
    }
    await deleteIndexedDb(id)
  },

  async clearAll(): Promise<void> {
    sessionKeys.clear()
    const vault = nativeKeyVault()
    if (vault) {
      try {
        await vault.clear()
      } catch {
        // Continue with the browser-store cleanup.
      }
    }
    const db = await getDb()
    await db.clear('keys')
  },

  async listMetadata(): Promise<Array<{ id: string; updatedAt: number }>> {
    const vault = nativeKeyVault()
    if (vault) {
      const ids = await vault.list()
      return ids.map((id) => ({ id, updatedAt: Date.now() }))
    }
    const db = await getDb()
    const rows = await db.getAll('keys')
    return rows.map(({ id, updatedAt }) => ({ id, updatedAt }))
  },

  isSessionOnly(id: string): boolean {
    return sessionKeys.has(id)
  },

  async migrateLegacyBrowserKeys(): Promise<void> {
    const vault = nativeKeyVault()
    if (!vault) return
    try {
      const db = await getDb()
      const rows = await db.getAll('keys')
      for (const row of rows) {
        if (!(await vault.get(row.id))) {
          await vault.set(row.id, row.secret)
        }
      }
      if (rows.length) {
        const tx = db.transaction('keys', 'readwrite')
        await tx.store.clear()
        await tx.done
      }
    } catch {
      // Keep the legacy records untouched if migration fails.
    }
  },
}
