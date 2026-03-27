/**
 * Simple {{ field }} template interpolation engine.
 * Supports dotted paths like {{ item.name }} and {{ item }} for for_each loops.
 */

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * Replace all {{ field }} placeholders in a template string with values from data.
 */
export function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key: string) => {
    const value = getNestedValue(data, key.trim())
    if (value === undefined || value === null) return ''
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  })
}

/**
 * Deep-interpolate all string values in an object/array structure.
 */
export function interpolateDeep<T>(obj: T, data: Record<string, unknown>): T {
  if (typeof obj === 'string') {
    return interpolate(obj, data) as T
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => interpolateDeep(item, data)) as T
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateDeep(value, data)
    }
    return result as T
  }
  return obj
}
