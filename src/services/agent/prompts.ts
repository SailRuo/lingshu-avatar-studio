import type { CharacterSpec } from '../../types/character'

export function buildBasePrompt(spec: CharacterSpec): string {
  const description = spec.description.trim()
  return [
    'front-facing bust portrait of a single original character,',
    'centered, symmetrical, head fully inside frame, shoulders visible,',
    spec.style ? `${spec.style},` : 'soft anime cel shading,',
    spec.hair ? `${spec.hair},` : '',
    spec.eyes ? `${spec.eyes},` : '',
    spec.outfit ? `${spec.outfit},` : '',
    spec.palette ? `${spec.palette},` : '',
    description,
    'eyes fully open, mouth closed, neutral expression,',
    'clean solid light-gray background, soft even lighting, high detail,',
    '2.5D anime key visual, crisp line art, separated hair silhouette,',
    'no hands, no props, no text, no watermark.',
    'Avoid: three-quarter view, side profile, looking away, cropped head,',
    'multiple characters, hands, arms raised, complex background, text,',
    'watermark, signature, logo, open mouth, closed eyes, extreme perspective,',
    'fisheye, heavy motion blur, accessories covering eyes.',
  ]
    .filter(Boolean)
    .join(' ')
}

export function summarizeSpecForVision(spec: CharacterSpec): string {
  return [
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    spec.style ? `style: ${spec.style}` : '',
    spec.hair ? `hair: ${spec.hair}` : '',
    spec.eyes ? `eyes: ${spec.eyes}` : '',
    spec.outfit ? `outfit: ${spec.outfit}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
