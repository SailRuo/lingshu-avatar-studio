import type { CharacterRecord } from '../../types/character'
import type {
  PlatformCharacterPayload,
  PlatformCharacterRecord,
} from '../../types/platform'

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function blobFromBytes(data: Uint8Array, mime: string): Blob {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return new Blob([copy.buffer], { type: mime || 'image/png' })
}

export async function toStoredCharacter(
  record: CharacterRecord,
): Promise<PlatformCharacterPayload> {
  const layers = await Promise.all(
    Object.entries(record.layers).map(async ([id, blob]) => ({
      id,
      mime: blob.type || 'image/png',
      data: new Uint8Array(await blob.arrayBuffer()),
    })),
  )
  const thumbnail = record.thumbnail
    ? {
        mime: record.thumbnail.type || 'image/png',
        data: new Uint8Array(await record.thumbnail.arrayBuffer()),
      }
    : null
  return {
    id: record.id,
    name: record.name,
    tier: record.manifest.tier,
    createdAt: record.createdAt,
    updatedAt: Date.now(),
    manifest: jsonClone(record.manifest),
    rig: jsonClone(record.rig),
    persona: jsonClone(record.persona),
    thumbnail,
    layers,
  }
}

export function fromStoredCharacter(row: PlatformCharacterRecord): CharacterRecord {
  const layers: Record<string, Blob> = {}
  for (const layer of row.layers) {
    layers[layer.id] = blobFromBytes(layer.data, layer.mime)
  }
  return {
    id: row.id,
    name: row.name,
    manifest: row.manifest,
    rig: row.rig,
    persona: row.persona,
    layers,
    thumbnail: row.thumbnail ? blobFromBytes(row.thumbnail.data, row.thumbnail.mime) : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function toPlainCharacter(record: CharacterRecord): CharacterRecord {
  return {
    ...record,
    manifest: jsonClone(record.manifest),
    rig: jsonClone(record.rig),
    persona: jsonClone(record.persona),
    layers: { ...record.layers },
    thumbnail: record.thumbnail,
  }
}

/**
 * Older characters put the back hair behind the head. The head layer carries a
 * baked-in copy of the hair (the face and the hair have to be warped together
 * when the head turns), so a back hair behind it never showed its sway — the
 * hair looked static while the bangs moved on top of it.
 *
 * The back hair now draws in front of the head, which needs no new pixels:
 * only the stacking order in the manifest changes.
 */
export function migrateCharacterRecord(record: CharacterRecord): CharacterRecord {
  const hairBack = record.manifest.layers.hairBack
  if (!hairBack || hairBack.z >= 26) return record
  return {
    ...record,
    manifest: {
      ...record.manifest,
      layers: {
        ...record.manifest.layers,
        hairBack: { ...hairBack, z: 26, parent: 'head' },
      },
    },
  }
}
