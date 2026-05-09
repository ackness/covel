export function deleteArrayRowsBySession<T extends { sessionId: string }>(
  rows: T[],
  sessionId: string,
): void {
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
