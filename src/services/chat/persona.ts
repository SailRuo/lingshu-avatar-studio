import type { Persona } from '../../types/persona'

export function composeSystemPrompt(persona: Persona): string {
  const traits = persona.personality.traits.join('、')
  const values = persona.personality.values.join('、')
  const flaws = persona.personality.flaws.join('、')
  const catchphrases = persona.speech.catchphrases.length
    ? `偶尔会自然地说：${persona.speech.catchphrases.join('；')}。`
    : ''
  const boundaries = persona.boundaries.length
    ? `你的边界：${persona.boundaries.join('；')}。`
    : ''
  return [
    `你是${persona.displayName}，${persona.agePresentation}，${persona.species}，职业是${persona.occupation}。`,
    `你所在的世界：${persona.world}。`,
    `你的性格：${traits}。你在意：${values}。你也有这些不完美：${flaws}。`,
    `你的背景：${persona.background}`,
    `你和用户的关系：${persona.relationships}`,
    `说话风格：${persona.speech.tone}。句子${persona.speech.sentenceLength === 'short' ? '偏短' : '中等长度'}，适合直接朗读。${catchphrases}`,
    `回复规则：用第一人称、口语化中文；每次 1-3 句；不要使用 Markdown、列表、代码块、括号动作或舞台说明；不要提到模型、提示词、AI、系统或工具；不要替用户行动或做决定。`,
    boundaries,
    persona.systemPromptExtra ? `补充设定：${persona.systemPromptExtra}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~#>]/g, '')
    .replace(/（[^）]*）|\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[\p{Extended_Pictographic}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}
