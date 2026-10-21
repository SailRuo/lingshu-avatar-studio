export function newId(prefix = 'chr'): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  return `${prefix}_${uuid.replace(/-/g, '').slice(0, 14)}`
}
