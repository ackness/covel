/**
 * The `id`s of an append-only collection, built on first use. Every helper here
 * that removes rows drops the collection's entry; the size check rebuilds an
 * index that missed a change anyway.
 */
const idIndexes = new WeakMap<readonly unknown[], Set<string>>();

/**
 * Append a row whose `id` must be new to the collection, as the SQL primary
 * key of its table requires: a second row under one `id` is an error, and the
 * first row stays as it was.
 */
export function appendUniqueRow<T extends { readonly id: string }>(
  rows: T[],
  row: T,
  label: string,
): void {
  const ids = assertNewRowId(rows, row.id, label);
  rows.push(row);
  ids.add(row.id);
}

/** Throw when the collection already holds a row with this `id`. */
export function assertNewRowId(
  rows: readonly { readonly id: string }[],
  id: string,
  label: string,
): Set<string> {
  let ids = idIndexes.get(rows);
  if (!ids || ids.size !== rows.length) {
    ids = new Set(rows.map((existing) => existing.id));
    idIndexes.set(rows, ids);
  }
  if (ids.has(id)) throw new Error(`${label} already exists: ${id}`);
  return ids;
}

/** Remove the row at `index`, keeping the collection's `id` index valid. */
export function removeRowAt(rows: unknown[], index: number): void {
  idIndexes.delete(rows);
  rows.splice(index, 1);
}

export function deleteArrayRowsBySession<T extends { sessionId: string }>(
  rows: T[],
  sessionId: string,
): void {
  idIndexes.delete(rows);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.sessionId === sessionId) rows.splice(i, 1);
  }
}

export function deleteMapRowsBySession<T extends { sessionId: string }>(
  rows: Map<string, T>,
  sessionId: string,
): void {
  for (const [key, row] of rows) {
    if (row.sessionId === sessionId) rows.delete(key);
  }
}

export function replaceArrayContents<T>(
  target: T[],
  source: readonly T[],
): void {
  idIndexes.delete(target);
  target.length = 0;
  target.push(...source);
}

export function replaceMapContents<K, V>(
  target: Map<K, V>,
  source: ReadonlyMap<K, V>,
): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}
