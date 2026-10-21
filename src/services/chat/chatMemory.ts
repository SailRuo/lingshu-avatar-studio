import type { ChatTurn } from './chatService'

const PREFIX = 'lingshu-avatar-studio.chat.'

export interface StoredChatTurn extends ChatTurn {
  ts: number
}

export function loadChat(characterId: string): StoredChatTurn[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(`${PREFIX}${characterId}`)
    if (!raw) return []
    const parsed = JSON.parse(raw) as StoredChatTurn[]
    return Array.isArray(parsed) ? parsed.filter((turn) => turn && typeof turn.text === 'string') : []
  } catch {
    return []
  }
}

export function saveChat(characterId: string, turns: StoredChatTurn[]): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(`${PREFIX}${characterId}`, JSON.stringify(turns.slice(-80)))
}

export function appendChat(characterId: string, turn: ChatTurn): StoredChatTurn[] {
  const next = [...loadChat(characterId), { ...turn, ts: Date.now() }].slice(-80)
  saveChat(characterId, next)
  return next
}

export function updateLastAssistant(characterId: string, text: string): StoredChatTurn[] {
  const turns = loadChat(characterId)
  const last = turns[turns.length - 1]
  if (last?.role === 'assistant') {
    last.text = text
    last.ts = Date.now()
    saveChat(characterId, turns)
  }
  return turns
}

export function clearChat(characterId: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(`${PREFIX}${characterId}`)
}
