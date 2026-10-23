import { getDb } from './db'

/**
 * Local model files are user-supplied. The app never bundles or downloads
 * weights; this store only keeps a file the user picked, so the licence of
 * each model stays between the user and its publisher.
 */
export interface StoredModelInfo {
  id: string
  name: string
  size: number
  importedAt: number
}

const META_PREFIX = 'local-model.'

function metaKey(id: string): string {
  return `${META_PREFIX}${id}.meta`
}

export async function getModelInfo(id: string): Promise<StoredModelInfo | null> {
  const db = await getDb()
  const row = await db.get('settings', metaKey(id))
  if (!row || typeof row.value !== 'object' || row.value === null) return null
  return row.value as StoredModelInfo
}

export async function loadModelBlob(id: string): Promise<Blob | null> {
  const db = await getDb()
  const row = await db.get('models', id)
  return row?.blob ?? null
}

export async function saveModel(id: string, file: File): Promise<StoredModelInfo> {
  const info: StoredModelInfo = {
    id,
    name: file.name,
    size: file.size,
    importedAt: Date.now(),
  }
  const db = await getDb()
  const tx = db.transaction(['models', 'settings'], 'readwrite')
  await tx.objectStore('models').put({ id, blob: file })
  await tx.objectStore('settings').put({ key: metaKey(id), value: info })
  await tx.done
  return info
}

export async function deleteModel(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['models', 'settings'], 'readwrite')
  await tx.objectStore('models').delete(id)
  await tx.objectStore('settings').delete(metaKey(id))
  await tx.done
}
