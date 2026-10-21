import { describe, expect, it } from 'vitest'
import type { CharacterManifest, CharacterRecord } from '../../src/types/character'
import type { RigDocument } from '../../src/types/rig'
import { defaultPersona } from '../../src/services/agent/persona'
import { exportCharacterZip } from '../../src/services/pack/exportZip'
import { importCharacterZip } from '../../src/services/pack/importZip'

function makeRecord(): CharacterRecord {
  const now = Date.now()
  const manifest: CharacterManifest = {
    format: 'lingshu-avatar',
    formatVersion: 1,
    id: 'chr_test',
    name: '测试角色',
    createdAt: now,
    updatedAt: now,
    tier: 'portrait',
    canvas: { width: 512, height: 768, pivot: { x: 256, y: 720 } },
    layerOrder: ['head'],
    layers: {
      head: {
        id: 'head',
        nameZh: '头部',
        z: 10,
        parent: 'head',
        pivot: { x: 256, y: 384 },
        offset: { x: 0, y: 0 },
        size: { w: 512, h: 768 },
        depth: 1,
        opacity: 1,
        defaultTexture: 'tex_head',
        textures: { default: 'tex_head' },
      },
    },
    textures: {
      tex_head: { file: 'layers/head.png', bbox: { x: 0, y: 0, w: 512, h: 768 } },
    },
    expressions: [],
    capabilities: { layered: false, blink: 'none', mouth: 'none', hair: false },
    files: { rig: 'rig.json', persona: 'persona.json', thumbnail: 'thumbnail.png' },
  }
  const rig: RigDocument = {
    formatVersion: 1,
    canvas: { width: 512, height: 768 },
    nodes: [{ id: 'root', parent: null, pivot: { x: 256, y: 720 }, depth: 0 }],
    meshes: {},
    parameters: [],
    bindings: [],
    states: [],
    motions: {},
    limits: { angleX: 0.45, angleY: 0.35, angleZ: 0.25 },
  }
  const persona = defaultPersona({
    name: '测试角色',
    description: '用于导出导入测试',
    style: '',
    hair: '',
    eyes: '',
    outfit: '',
    palette: '',
    aspect: '2:3',
  })
  const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
    type: 'image/png',
  })
  return {
    id: manifest.id,
    name: manifest.name,
    manifest,
    rig,
    persona,
    layers: { head: png },
    createdAt: now,
    updatedAt: now,
  }
}

describe('character pack', () => {
  it('round-trips a character through ZIP with a new id', async () => {
    const record = makeRecord()
    const zip = await exportCharacterZip(record)
    expect(zip.size).toBeGreaterThan(100)
    const file = new File([await zip.arrayBuffer()], 'character.zip', { type: 'application/zip' })
    const imported = await importCharacterZip(file)
    expect(imported.name).toBe('测试角色')
    expect(imported.id).not.toBe(record.id)
    expect(Object.keys(imported.layers)).toEqual(['head'])
    expect(imported.manifest.format).toBe('lingshu-avatar')
    expect(imported.persona.displayName).toBe('测试角色')
    expect(JSON.stringify(imported.manifest)).not.toContain('apiKey')
  })
})
