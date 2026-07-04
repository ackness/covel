export function stateEntryKey(
  sessionId: string,
  tableName: string,
  fieldName: string,
): string {
  return `${sessionId}:${tableName}:${fieldName}`;
}

export function pluginDataKey(
  sessionId: string,
  pluginId: string,
  namespace: string,
  key: string,
): string {
  return `${sessionId}:${pluginId}:${namespace}:${key}`;
}

export function workingMemoryKey(
  sessionId: string,
  scope: string,
  key: string,
): string {
  return `${sessionId}:${scope}:${key}`;
}

export function lorebookEntryKey(sessionId: string, id: string): string {
  return `${sessionId}:${id}`;
}

export function vectorRowKey(
  sessionId: string,
  pluginId: string,
  namespace: string,
  key: string,
): string {
  return `${sessionId}:${pluginId}:${namespace}:${key}`;
}
