import type { Persona } from './persona'
import type { RigDocument } from './rig'

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type CharacterTier = 'full' | 'layered-lite' | 'portrait-plus' | 'portrait'

export type LayerId =
  | 'hairBack'
  | 'body'
  | 'head'
  | 'headBase'
  | 'face'
  | 'browL'
  | 'browR'
  | 'eyeL'
  | 'eyeR'
  | 'mouth'
  | 'blush'
  | 'hairSide'
  | 'hairFront'
  | 'fx'

export interface LayerDef {
  id: LayerId
  nameZh: string
  z: number
  parent: 'root' | 'body' | 'head'
  pivot: Point
  offset: Point
  size: { w: number; h: number }
  depth: number
  opacity: number
  defaultTexture: string
  textures: Record<string, string>
}

export interface TextureDef {
  file: string
  bbox: Rect
}

export interface ExpressionDef {
  id: string
  nameZh: string
  textures: Record<string, string>
  crossfadeMs?: number
}

export interface CharacterManifest {
  format: 'lingshu-avatar'
  formatVersion: 1
  id: string
  name: string
  createdAt: number
  updatedAt: number
  tier: CharacterTier
  canvas: { width: number; height: number; pivot: Point }
  layerOrder: LayerId[]
  layers: Partial<Record<LayerId, LayerDef>>
  textures: Record<string, TextureDef>
  expressions: ExpressionDef[]
  capabilities: {
    layered: boolean
    blink: 'texture' | 'warp' | 'none'
    mouth: 'texture' | 'warp' | 'none'
    hair: boolean
  }
  source?: {
    providerId?: string
    model?: string
    prompt?: string
    seed?: number
    variantMode?: 'mask-edit' | 'instruction-edit' | 'warp' | 'none'
  }
  files: {
    rig: string
    persona: string
    thumbnail?: string
  }
  notes?: string[]
}

export interface CharacterRecord {
  id: string
  name: string
  manifest: CharacterManifest
  rig: RigDocument
  persona: Persona
  layers: Record<string, Blob>
  thumbnail?: Blob
  createdAt: number
  updatedAt: number
}

export interface CharacterMeta {
  id: string
  name: string
  tier: CharacterTier
  thumbnailUrl?: string
  updatedAt: number
}

export interface CharacterSpec {
  name: string
  description: string
  style: string
  hair: string
  eyes: string
  outfit: string
  palette: string
  aspect: '2:3' | '1:1' | '3:4'
  seed?: number
}
