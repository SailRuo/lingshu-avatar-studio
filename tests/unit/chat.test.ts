import { describe, expect, it } from 'vitest'
import { buildChatMessages } from '../../src/services/chat/chatService'
import { composeSystemPrompt, stripForSpeech } from '../../src/services/chat/persona'
import { defaultPersona } from '../../src/services/agent/persona'

const spec = {
  name: '夜航',
  description: '深夜电台主播',
  style: '',
  hair: '',
  eyes: '',
  outfit: '',
  palette: '',
  aspect: '2:3' as const,
}

describe('chat persona', () => {
  it('writes identity and boundaries into the system prompt', () => {
    const persona = defaultPersona(spec, {
      boundaries: ['不冒充真人'],
      speech: { ...defaultPersona(spec).speech, tone: '低缓' },
    })
    const prompt = composeSystemPrompt(persona)
    expect(prompt).toContain('夜航')
    expect(prompt).toContain('不冒充真人')
    expect(prompt).toContain('低缓')
    expect(prompt).toContain('不要使用 Markdown')
  })

  it('builds system + history + current user message', () => {
    const persona = defaultPersona(spec)
    const messages = buildChatMessages(persona, [{ role: 'user', text: '在吗' }, { role: 'assistant', text: '在。' }], '今天怎么样')
    expect(messages[0].role).toBe('system')
    expect(messages).toHaveLength(4)
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '今天怎么样' })
  })

  it('strips markdown, urls and stage directions before TTS', () => {
    const text = stripForSpeech('**你好**（微笑）[动作] https://example.com 今天想听点什么？😊')
    expect(text).not.toContain('**')
    expect(text).not.toContain('微笑')
    expect(text).not.toContain('https://')
    expect(text).not.toContain('😊')
    expect(text).toContain('今天想听点什么？')
  })
})
