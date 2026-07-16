export interface ChatExportMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
}

/** Merge persisted history with uncommitted in-memory rows by authoritative id. */
export function mergeChatExportMessages(
  persisted: readonly ChatExportMessage[],
  inMemory: readonly ChatExportMessage[],
): readonly ChatExportMessage[] {
  const persistedIds = new Set(persisted.map((message) => message.id));
  return [
    ...persisted,
    ...inMemory.filter((message) => !persistedIds.has(message.id)),
  ];
}
