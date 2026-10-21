import type { Persona } from '../../types/persona'
import type { ProviderConfig } from '../../types/provider'
import { streamChat, type ChatMessage } from '../providers/chat'
import { composeSystemPrompt } from './persona'

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface SendChatOptions {
  provider: ProviderConfig
  apiKey: string
  model: string
  persona: Persona
  history: ChatTurn[]
  userText: string
  signal?: AbortSignal
  onDelta?: (text: string) => void
}

export function buildChatMessages(persona: Persona, history: ChatTurn[], userText: string): ChatMessage[] {
  const turns = history.slice(-12).map((turn) => ({
    role: turn.role,
    content: turn.text,
  })) as ChatMessage[]
  return [
    { role: 'system', content: composeSystemPrompt(persona) },
    ...turns,
    { role: 'user', content: userText },
  ]
}

export async function sendChat(options: SendChatOptions): Promise<string> {
  return streamChat({
    provider: options.provider,
    apiKey: options.apiKey,
    model: options.model,
    messages: buildChatMessages(options.persona, options.history, options.userText),
    signal: options.signal,
    temperature: 0.85,
    onDelta: options.onDelta,
  })
}
