import { describe, expect, it } from 'vitest'
import type { CharacterRecord, CharacterSpec, LayerDef, LayerId } from '../../src/types/character'
import type { ProviderConfig } from '../../src/types/provider'
import { editSizeForProvider } from '../../src/services/providers/imageSizes'
import {
  appendNotes,
  buildPartPrompt,
  defaultPartInstruction,
  partSpec,
  specForRecord,
} from '../../src/services/agent/redrawPlan'
import { partExists } from '../../src/services/imaging/compose'

function provider(kind: ProviderConfig['kind']): ProviderConfig {
  return {
    id: kind,
    label: kind,
    kind,
    baseUrl: 'https://example.com',
    models: { image: 'model' },
    extra: {},
    capabilities: ['image'],
    supportsEdit: true,
  }
}

function layer(id: LayerId, z: number): LayerDef {
  return {
    id,
    nameZh: id,
    z,
    parent: 'head',
    pivot: { x: 0, y: 0 },
    offset: { x: 0, y: 0 },
    size: { w: 100, h: 100 },
    depth: 1,
    opacity: 1,
    defaultTexture: `tex_${id}`,
    textures: { default: `tex_${id}` },
  }
}

function recordWithLayers(ids: LayerId[]): CharacterRecord {
  const layers: Partial<Record<LayerId, LayerDef>> = {}
  ids.forEach((id, index) => {
    layers[id] = layer(id, index)
  })
  return {
    id: 'chr_test',
    name: '测试',
    manifest: {
      format: 'lingshu-avatar',
      formatVersion: 1,
      id: 'chr_test',
      name: '测试',
      createdAt: 1,
      updatedAt: 2,
      tier: 'full',
      canvas: { width: 1024, height: 1536, pivot: { x: 512, y: 1440 } },
      layerOrder: ids,
      layers,
      textures: {},
      expressions: [],
      capabilities: { layered: true, blink: 'warp', mouth: 'warp', hair: true },
      files: { rig: 'rig.json', persona: 'persona.json' },
      notes: ['已有说明'],
    },
    rig: {
      formatVersion: 1,
      canvas: { width: 1024, height: 1536 },
      nodes: [],
      meshes: {},
      parameters: [],
      bindings: [],
      states: [],
      motions: {},
      limits: { angleX: 0.45, angleY: 0.35, angleZ: 0.25 },
    },
    persona: {
      displayName: '测试',
      occupation: '测试职业',
      background: '',
    } as CharacterRecord['persona'],
    layers: Object.fromEntries(ids.map((id) => [id, new Blob()])),
    createdAt: 1,
    updatedAt: 2,
  }
}

const spec: CharacterSpec = {
  name: '疏影',
  description: '旧园琴师',
  style: 'semi-realistic',
  hair: '及腰墨发，松挽发髻',
  eyes: '浅茶色眼睛',
  outfit: '月白交领长衫',
  palette: '月白、黛青',
  aspect: '3:4',
}

describe('edit sizing', () => {
  it('maps portrait canvases to gpt-image-1 legal sizes', () => {
    expect(editSizeForProvider(provider('openai-compatible'), 1142, 1536)).toEqual({
      width: 1024,
      height: 1536,
      size: '1024x1536',
    })
    expect(editSizeForProvider(provider('openai-compatible'), 1024, 1024).size).toBe('1024x1024')
    expect(editSizeForProvider(provider('openai-compatible'), 1600, 1000).size).toBe('1536x1024')
  })

  it('uses the provider size table for reference-edit providers', () => {
    expect(editSizeForProvider(provider('ark'), 1024, 1536).size).toBe('1536x2304')
    expect(editSizeForProvider(provider('siliconflow'), 1024, 1536).size).toBe('960x1280')
  })
})

describe('part prompts', () => {
  it('puts the part field and the mask constraint in the prompt', () => {
    const hair = buildPartPrompt(spec, 'hair')
    expect(hair).toContain('hair')
    expect(hair).toContain('及腰墨发')
    expect(hair).toContain('outside the masked area')
    const body = buildPartPrompt(spec, 'body')
    expect(body).toContain('月白交领长衫')
    const head = buildPartPrompt(spec, 'head')
    expect(head).toContain('浅茶色眼睛')
  })

  it('lets an explicit instruction override the default field', () => {
    const prompt = buildPartPrompt(spec, 'hair', 'short silver hair')
    expect(prompt).toContain('short silver hair')
    expect(prompt).not.toContain('及腰墨发')
  })

  it('builds a reference prompt that states the purpose and excludes other parts', () => {
    const prompt = buildPartPrompt(spec, 'hair', undefined, 'reference')
    expect(prompt).toContain('layered 2D avatar asset')
    expect(prompt).toContain('isolated')
    expect(prompt).toContain('Do not include the face')
    expect(prompt).toContain('used as the hair layer')
    const maskPrompt = buildPartPrompt(spec, 'hair', undefined, 'mask')
    expect(maskPrompt).toContain('inside the masked area')
    expect(maskPrompt).not.toContain('layered 2D avatar asset')
  })

  it('falls back to a generic instruction when the brief is empty', () => {
    const empty = { ...spec, hair: '', eyes: '', outfit: '' }
    expect(defaultPartInstruction(empty, 'hair')).toContain('hairstyle')
    expect(defaultPartInstruction(empty, 'head')).toContain('identity')
  })
})

describe('part layer mapping', () => {
  it('registers body, head, hair, eyes and mouth', () => {
    expect(partSpec('hair').layers.map((entry) => entry.id)).toEqual(['hairFront', 'hairBack'])
    expect(partSpec('body').layers[0].id).toBe('body')
    expect(partSpec('mouth').layers[0].id).toBe('mouth')
  })

  it('only exposes parts that exist in the record', () => {
    const record = recordWithLayers(['body', 'head', 'hairFront'])
    expect(partExists(record, 'body')).toBe(true)
    expect(partExists(record, 'hair')).toBe(true)
    expect(partExists(record, 'eyeL')).toBe(false)
  })

  it('falls back from head to headBase', () => {
    const record = recordWithLayers(['body', 'headBase'])
    expect(partExists(record, 'head')).toBe(true)
  })
})

describe('record helpers', () => {
  it('prefers the saved spec over a derived one', () => {
    const record = recordWithLayers(['head'])
    record.manifest.source = { spec }
    expect(specForRecord(record)).toBe(spec)
  })

  it('derives a spec and aspect from the canvas for old records', () => {
    const record = recordWithLayers(['head'])
    record.manifest.canvas.width = 1152
    const derived = specForRecord(record)
    expect(derived.name).toBe('测试')
    expect(derived.aspect).toBe('3:4')
  })

  it('appends notes without duplicates and touches updatedAt', () => {
    const record = recordWithLayers(['head'])
    const next = appendNotes(record, ['已有说明', '已重绘头部。'])
    expect(next.manifest.notes).toEqual(['已有说明', '已重绘头部。'])
    expect(next.manifest.updatedAt).not.toBe(record.manifest.updatedAt)
    expect(next.id).toBe(record.id)
  })
})
