import { strToU8, zipSync, type Zippable } from 'fflate'
import type { CharacterRecord } from '../../types/character'
import { getPlatform, isNativeRuntime } from '../platform/bridge'

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

export async function exportCharacterZip(record: CharacterRecord): Promise<Blob> {
  const files: Zippable = {
    'manifest.json': strToU8(JSON.stringify(record.manifest, null, 2)),
    'rig.json': strToU8(JSON.stringify(record.rig, null, 2)),
    'persona.json': strToU8(JSON.stringify(record.persona, null, 2)),
  }
  for (const [layerId, blob] of Object.entries(record.layers)) {
    files[`layers/${layerId}.png`] = [await blobToBytes(blob), { level: 6 }]
  }
  if (record.thumbnail) {
    files['thumbnail.png'] = [await blobToBytes(record.thumbnail), { level: 6 }]
  }
  const zipped = zipSync(files, { level: 6 })
  return new Blob([zipped], { type: 'application/zip' })
}

export async function downloadBlob(blob: Blob, filename: string): Promise<boolean> {
  if (isNativeRuntime()) {
    const extension = filename.split('.').pop()?.toLowerCase() || 'bin'
    const filters =
      extension === 'psd'
        ? [{ name: 'Photoshop', extensions: ['psd'] }]
        : [{ name: 'ZIP', extensions: ['zip'] }]
    const result = await getPlatform().saveFile({
      defaultName: filename,
      filters,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    })
    return result.saved
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4000)
  return true
}
