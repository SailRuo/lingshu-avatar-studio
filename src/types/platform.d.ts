import type { CharacterManifest, CharacterTier } from './character'
import type { Persona } from './persona'
import type { RigDocument } from './rig'

export interface PlatformHttpMeta {
  type: 'meta'
  id: string
  status: number
  statusText: string
  headers: Record<string, string>
}

export interface PlatformHttpChunk {
  type: 'chunk'
  id: string
  chunk: Uint8Array
}

export interface PlatformHttpEnd {
  type: 'end'
  id: string
}

export interface PlatformHttpError {
  type: 'error'
  id: string
  name?: string
  message?: string
}

export type PlatformHttpEvent =
  | PlatformHttpMeta
  | PlatformHttpChunk
  | PlatformHttpEnd
  | PlatformHttpError

export interface PlatformFormPart {
  name: string
  value?: string
  filename?: string
  type?: string
  bytes?: Uint8Array
}

export interface PlatformHttpRequest {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  bodyType?: 'text' | 'bytes' | 'formdata'
  bodyText?: string
  bodyBytes?: Uint8Array
  parts?: PlatformFormPart[]
}

export interface PlatformSaveResult {
  saved: boolean
  path?: string
}

export interface FishLiveStart {
  token: string
  baseUrl: string
  apiKey: string
  model: string
  referenceId: string
  format: 'pcm' | 'mp3'
  latency: string
  sampleRate: number
}

export type FishLiveEvent =
  | { token: string; type: 'ready' }
  | { token: string; type: 'audio'; data: Uint8Array }
  | { token: string; type: 'finish'; reason: string }
  | { token: string; type: 'error'; message: string }
  | { token: string; type: 'closed'; code: number; reason: string }

export interface PlatformBlobPayload {
  mime: string
  data: Uint8Array
}

export interface PlatformCharacterLayer {
  id: string
  mime: string
  data: Uint8Array
}

export interface PlatformCharacterPayload {
  id: string
  name: string
  tier: CharacterTier
  createdAt: number
  updatedAt: number
  manifest: CharacterManifest
  rig: RigDocument
  persona: Persona
  thumbnail: PlatformBlobPayload | null
  layers: PlatformCharacterLayer[]
}

export interface PlatformCharacterListRow {
  id: string
  name: string
  tier: CharacterTier
  updatedAt: number
  thumbnail: Uint8Array | null
  thumbnailMime: string | null
}

export interface PlatformCharacterRecord {
  id: string
  name: string
  tier: CharacterTier
  createdAt: number
  updatedAt: number
  manifest: CharacterManifest
  rig: RigDocument
  persona: Persona
  thumbnail: PlatformBlobPayload | null
  layers: PlatformCharacterLayer[]
}


