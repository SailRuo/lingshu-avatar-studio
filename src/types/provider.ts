export type ProviderRole = 'image' | 'chat' | 'tts'

export type ProviderKind =
  | 'openai-compatible'
  | 'ark'
  | 'siliconflow'
  | 'dashscope'
  | 'sensenova'
  | 'minimax'
  | 'elevenlabs'
  | 'fishaudio'

export type ProviderCapability = ProviderRole

export interface ProviderConfig {
  id: string
  label: string
  kind: ProviderKind
  baseUrl: string
  proxyUrl?: string
  models: {
    image?: string
    chat?: string
    tts?: string
  }
  extra: {
    groupId?: string
    voiceId?: string
    defaultVoice?: string
    /** Fish Audio 音色模型 ID（reference_id），例如 Fish 广场上的模型 ID。 */
    referenceId?: string
    /** Fish Audio 延迟档：low_latency / balanced / high_quality。 */
    latency?: string
  }
  capabilities: ProviderCapability[]
  supportsEdit: boolean
  /** The upstream blocks browser CORS; only usable with a user-supplied proxy. */
  requiresProxy?: boolean
  builtin?: boolean
}

export type CapabilityStatus =
  | 'ok'
  | 'auth_error'
  | 'cors_blocked'
  | 'model_missing'
  | 'quota'
  | 'unsupported'
  | 'network'
  | 'unknown'

export interface CapabilityReport {
  providerId: string
  role: ProviderRole
  status: CapabilityStatus
  httpStatus?: number
  latencyMs?: number
  model?: string
  message: string
  testedAt: number
  details?: string
}

export interface RoleBindings {
  image?: string
  chat?: string
  tts?: string
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
