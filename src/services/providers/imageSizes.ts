import type { ProviderConfig } from '../../types/provider'

export type ImageAspect = '2:3' | '1:1' | '3:4'

export function aspectToSize(aspect: ImageAspect, provider?: ProviderConfig): string {
  if (provider?.kind === 'sensenova') {
    if (aspect === '1:1') return '2048x2048'
    if (aspect === '3:4') return '1760x2368'
    return '1664x2496'
  }
  if (provider?.kind === 'ark') {
    if (aspect === '1:1') return '2048x2048'
    if (aspect === '3:4') return '1728x2304'
    return '1536x2304'
  }
  if (provider?.kind === 'siliconflow') {
    if (aspect === '1:1') return '1024x1024'
    return '960x1280'
  }
  if (aspect === '1:1') return '1024x1024'
  if (aspect === '3:4') return '768x1024'
  return '1024x1536'
}

export interface EditSize {
  width: number
  height: number
  size: string
}

/**
 * The edit endpoint has stricter size rules than generation. gpt-image-1 only
 * accepts 1024x1024, 1536x1024 and 1024x1536; the 3:4 mapping used for
 * generation (768x1024) would be rejected.
 */
export function editSizeForProvider(
  provider: ProviderConfig,
  width: number,
  height: number,
): EditSize {
  const ratio = width / Math.max(1, height)
  if (provider.kind === 'openai-compatible') {
    if (ratio > 1.15) return { width: 1536, height: 1024, size: '1536x1024' }
    if (ratio < 0.87) return { width: 1024, height: 1536, size: '1024x1536' }
    return { width: 1024, height: 1024, size: '1024x1024' }
  }
  const aspect: ImageAspect = ratio < 0.74 ? '2:3' : ratio < 0.95 ? '3:4' : '1:1'
  const size = aspectToSize(aspect, provider)
  const [w, h] = size.split('x').map((value) => Number(value))
  return { width: w || 1024, height: h || 1024, size }
}
