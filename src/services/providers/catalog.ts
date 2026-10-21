import type { ProviderConfig } from '../../types/provider'

export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    models: {
      image: 'gpt-image-1',
      chat: 'gpt-4o-mini',
      tts: 'gpt-4o-mini-tts',
    },
    extra: { defaultVoice: 'alloy' },
    capabilities: ['image', 'chat', 'tts'],
    supportsEdit: true,
    builtin: true,
  },
  {
    id: 'ark',
    label: '火山方舟',
    kind: 'ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: {
      image: 'doubao-seedream-5-0-260128',
      chat: 'doubao-seed-2-1-turbo-260628',
    },
    extra: {},
    capabilities: ['image', 'chat'],
    supportsEdit: true,
    builtin: true,
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    kind: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: {
      image: 'Kwai-Kolors/Kolors',
      chat: 'Qwen/Qwen2.5-VL-72B-Instruct',
      tts: 'FunAudioLLM/CosyVoice2-0.5B',
    },
    extra: { defaultVoice: 'FunAudioLLM/CosyVoice2-0.5B:alex' },
    capabilities: ['image', 'chat', 'tts'],
    supportsEdit: true,
    builtin: true,
  },
  {
    id: 'sensenova',
    label: '商汤日日新',
    kind: 'sensenova',
    baseUrl: 'https://token.sensenova.cn/v1',
    models: {
      image: 'sensenova-u1.5-lite',
    },
    extra: {},
    capabilities: ['image'],
    supportsEdit: true,
    requiresProxy: true,
    builtin: true,
  },
  {
    id: 'dashscope',
    label: '阿里云百炼',
    kind: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: {
      chat: 'qwen-vl-max-latest',
    },
    extra: {},
    capabilities: ['chat'],
    supportsEdit: false,
    builtin: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: {
      chat: 'gemini-2.5-flash',
    },
    extra: {},
    capabilities: ['chat'],
    supportsEdit: false,
    builtin: true,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    kind: 'minimax',
    baseUrl: 'https://api.minimax.chat/v1',
    models: {
      tts: 'speech-2.6-hd',
    },
    extra: { defaultVoice: 'female-shaonv' },
    capabilities: ['tts'],
    supportsEdit: false,
    builtin: true,
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    kind: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io/v1',
    models: {
      tts: 'eleven_multilingual_v2',
    },
    extra: { voiceId: '21m00Tcm4TlvDq8ikWAM', defaultVoice: '21m00Tcm4TlvDq8ikWAM' },
    capabilities: ['tts'],
    supportsEdit: false,
    builtin: true,
  },
  {
    id: 'fishaudio',
    label: 'Fish Audio',
    kind: 'fishaudio',
    baseUrl: 'https://api.fish.audio',
    models: {
      tts: 's2.1-pro-free',
    },
    // 音色模型 ID 存在 referenceId；留空则用 Fish 的默认音色。
    extra: { referenceId: '', latency: 'balanced' },
    capabilities: ['tts'],
    supportsEdit: false,
    builtin: true,
  },
]

export const MODEL_SUGGESTIONS: Record<string, string[]> = {
  openai: [
    'gpt-image-1',
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1-mini',
    'gpt-4o-mini-tts',
    'tts-1',
  ],
  ark: [
    'doubao-seedream-5-0-260128',
    'doubao-seedream-5-0-pro-260628',
    'doubao-seedream-4-5-251128',
    'doubao-seed-2-1-turbo-260628',
  ],
  siliconflow: [
    'Kwai-Kolors/Kolors',
    'Qwen/Qwen-Image',
    'Qwen/Qwen2.5-VL-72B-Instruct',
    'FunAudioLLM/CosyVoice2-0.5B',
  ],
  sensenova: ['sensenova-u1.5-lite', 'sensenova-u1.5-fast'],
  dashscope: ['qwen-vl-max-latest', 'qwen-vl-plus', 'qwen-max', 'qwen-plus'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  minimax: ['speech-2.6-hd', 'speech-02-hd'],
  elevenlabs: ['eleven_multilingual_v2', 'eleven_turbo_v2_5'],
  fishaudio: ['s2.1-pro-free', 'speech-1.6', 's1'],
}

export function suggestedModels(provider: ProviderConfig | undefined): string[] {
  if (!provider) return []
  return MODEL_SUGGESTIONS[provider.id] ?? Object.values(provider.models).filter(Boolean)
}

export function createCustomProvider(): ProviderConfig {
  return {
    id: `custom-${Date.now().toString(36)}`,
    label: '自定义 OpenAI 兼容',
    kind: 'openai-compatible',
    baseUrl: '',
    models: {},
    extra: { defaultVoice: 'alloy' },
    capabilities: ['image', 'chat', 'tts'],
    supportsEdit: true,
    builtin: false,
  }
}

export function providerSupports(provider: ProviderConfig | undefined, capability: string): boolean {
  return !!provider?.capabilities.includes(capability as never)
}
