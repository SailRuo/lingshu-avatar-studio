export interface Persona {
  version: 1
  displayName: string
  pronouns: string
  agePresentation: string
  species: string
  occupation: string
  world: string
  personality: {
    traits: string[]
    values: string[]
    flaws: string[]
  }
  speech: {
    language: 'zh-CN' | 'en-US' | 'ja-JP'
    tone: string
    catchphrases: string[]
    sentenceLength: 'short' | 'medium'
    emoji: boolean
  }
  background: string
  relationships: string
  boundaries: string[]
  greeting: string
  systemPromptExtra: string
  voice: {
    providerId?: string
    model?: string
    voiceId?: string
    speed: number
    visemeMode: 'envelope' | 'approx'
  }
  memory: {
    enabled: boolean
    maxTurns: number
  }
}
