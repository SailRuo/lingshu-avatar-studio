import { describe, expect, it } from 'vitest'
import { normalizeReview } from '../../src/services/agent/reviewCharacter'

describe('agent review normalization', () => {
  it('scales a 0..1 score and keeps a pass result', () => {
    const review = normalizeReview({
      score: 0.82,
      summary: '整体可用',
      issues: [],
      recommendedAction: 'none',
    })
    expect(review.score).toBe(82)
    expect(review.recommendedAction).toBe('none')
    expect(review.summary).toBe('整体可用')
  })

  it('keeps a local redraw recommendation and target', () => {
    const review = normalizeReview({
      score: 61,
      issues: [
        {
          severity: 'warn',
          part: 'hair',
          message: '发髻与设定不符',
          suggestion: 'redraw',
          instruction: '重新画发髻，保留脸和衣服',
        },
      ],
      recommendedAction: 'redraw',
      targetPart: 'hair',
      repairInstruction: '重新画发髻',
    })
    expect(review.targetPart).toBe('hair')
    expect(review.repairInstruction).toBe('重新画发髻')
    expect(review.issues[0].part).toBe('hair')
  })

  it('falls back to the issue part when targetPart is missing', () => {
    const review = normalizeReview({
      recommendedAction: 'redraw',
      issues: [
        { severity: 'block', part: 'body', message: '衣领接缝', suggestion: 'redraw' },
      ],
    })
    expect(review.targetPart).toBe('body')
  })

  it('downgrades an unusable redraw to none and rejects invalid JSON', () => {
    expect(normalizeReview({ recommendedAction: 'redraw' }).recommendedAction).toBe('none')
    expect(() => normalizeReview(null)).toThrow()
  })

  it('drops malformed issues but keeps valid ones', () => {
    const review = normalizeReview({
      recommendedAction: 'regenerate',
      issues: [
        { severity: 'block', part: 'none', message: '大面积白色矩形背景', suggestion: 'regenerate' },
        { part: 'hair' },
      ],
    })
    expect(review.issues).toHaveLength(1)
    expect(review.issues[0].severity).toBe('block')
    expect(review.recommendedAction).toBe('regenerate')
  })
})
