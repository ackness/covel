const INVENTORY_LABEL_KEYS = [
  'name',
  'item_name',
  'itemName',
  'title',
  'label',
  'display_name',
  'displayName',
  'text',
] as const

const INVENTORY_NESTED_KEYS = [
  'item',
  'data',
  'value',
  'payload',
  'content',
  'meta',
] as const

function pickLabel(value: unknown, seen: WeakSet<object>, depth = 0): string | null {
  if (depth > 3) return null

  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = pickLabel(item, seen, depth + 1)
      if (candidate) return candidate
    }
    return null
  }
  if (!value || typeof value !== 'object') {
    return null
  }

  if (seen.has(value)) return null
  seen.add(value)

  const obj = value as Record<string, unknown>

  for (const key of INVENTORY_LABEL_KEYS) {
    const candidate = pickLabel(obj[key], seen, depth + 1)
    if (candidate) return candidate
  }

  for (const key of INVENTORY_NESTED_KEYS) {
    const candidate = pickLabel(obj[key], seen, depth + 1)
    if (candidate) return candidate
  }

  for (const [key, entry] of Object.entries(obj)) {
    if (
      INVENTORY_LABEL_KEYS.includes(key as (typeof INVENTORY_LABEL_KEYS)[number]) ||
      INVENTORY_NESTED_KEYS.includes(key as (typeof INVENTORY_NESTED_KEYS)[number])
    ) {
      continue
    }
    if (typeof entry === 'string') {
      const trimmed = entry.trim()
      if (trimmed) return trimmed
    }
  }

  for (const entry of Object.values(obj)) {
    const candidate = pickLabel(entry, seen, depth + 1)
    if (candidate) return candidate
  }

  return null
}

export function normalizeInventoryItemLabel(item: unknown): string {
  const label = pickLabel(item, new WeakSet())
  if (label) return label
  if (typeof item === 'object' && item !== null) {
    try {
      const json = JSON.stringify(item)
      if (json && json !== '{}' && json !== '[]') return json
    } catch {
      // noop
    }
  }
  return typeof item === 'string' ? item : ''
}

