/**
 * Runtime validation helpers for IndexedDB records.
 * Replaces unsafe `as unknown as T` double casts with lightweight shape checks.
 */

/** Check that a value is a non-null object (not an array). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Filter an array of IDB rows, keeping only those that look like valid records
 * with the required keys present.
 */
export function validateIdbRows<T>(
  rows: unknown[],
  requiredKeys: string[],
): T[] {
  return rows.filter((row): row is T => {
    if (!isRecord(row)) return false
    return requiredKeys.every((key) => key in row)
  })
}

/**
 * Safely convert a typed object to Record<string, unknown> for IDB storage.
 * Uses structured clone semantics (spread) to avoid unsafe double casts.
 */
export function toIdbRecord(obj: object): Record<string, unknown> {
  return { ...obj }
}

/**
 * Validate a single IDB record has the required shape.
 * Returns the record cast to T, or undefined if invalid.
 */
export function validateIdbRecord<T>(
  row: unknown,
  requiredKeys: string[],
): T | undefined {
  if (!isRecord(row)) return undefined
  if (!requiredKeys.every((key) => key in row)) return undefined
  return row as T
}
