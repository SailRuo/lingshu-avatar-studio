import { strFromU8, unzipSync } from 'fflate'
import type { CharacterManifest, CharacterRecord } from '../../types/character'
import type { Persona } from '../../types/persona'
import type { RigDocument } from '../../types/rig'
import { newId } from '../id'

const MAX_ZIP_BYTES = 60 * 1024 * 1024

function safePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\')) return false
  const parts = path.split('/')
  return parts.every((part) => part !== '..' && part !== '.')
}

function parseJson<T>(bytes: Uint8Array, filename: string): T {
  try {
    return JSON.parse(strFromU8(bytes)) as T
  } catch {
    throw new Error(`${filename} 不是有效的 JSON。`)
  }
}

function validateManifest(manifest: CharacterManifest): void {
  if (manifest.format !== 'lingshu-avatar' || manifest.formatVersion !== 1) {
    throw new Error('不是 Avatar Studio 角色包，或格式版本不支持。')
  }
  if (!manifest.canvas?.width || !manifest.canvas?.height) throw new Error('角色包缺少画布尺寸。')
  if (!manifest.layers || typeof manifest.layers !== 'object') throw new Error('角色包缺少图层。')
  if (!manifest.textures || typeof manifest.textures !== 'object') throw new Error('角色包缺少纹理索引。')
}

export async function importCharacterZip(file: File): Promise<CharacterRecord> {
  if (file.size > MAX_ZIP_BYTES) throw new Error('角色包超过 60MB，已拒绝导入。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(bytes)
  } catch {
    throw new Error('无法解压角色包。')
  }
  for (const name of Object.keys(unzipped)) {
    if (!safePath(name)) throw new Error(`角色包包含不安全路径：${name}`)
  }
  if (!unzipped['manifest.json']) throw new Error('角色包缺少 manifest.json。')
  if (!unzipped['rig.json']) throw new Error('角色包缺少 rig.json。')
  if (!unzipped['persona.json']) throw new Error('角色包缺少 persona.json。')

  const manifest = parseJson<CharacterManifest>(unzipped['manifest.json'], 'manifest.json')
  validateManifest(manifest)
  const rig = parseJson<RigDocument>(unzipped['rig.json'], 'rig.json')
  const persona = parseJson<Persona>(unzipped['persona.json'], 'persona.json')

  const id = newId('chr')
  manifest.id = id
  manifest.updatedAt = Date.now()
  if (manifest.files) manifest.files.thumbnail = 'thumbnail.png'

  const layers: Record<string, Blob> = {}
  for (const [layerId, def] of Object.entries(manifest.layers)) {
    if (!def) continue
    const texture = manifest.textures[def.defaultTexture]
    if (!texture) continue
    const data = unzipped[texture.file]
    if (data) layers[layerId] = new Blob([data], { type: 'image/png' })
  }
  if (!Object.keys(layers).length) throw new Error('角色包里没有可用的图层文件。')

  const thumbnailBytes = unzipped['thumbnail.png']
  const thumbnail = thumbnailBytes
    ? new Blob([thumbnailBytes], { type: 'image/png' })
    : undefined

  return {
    id,
    name: manifest.name,
    manifest,
    rig,
    persona,
    layers,
    thumbnail,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}
