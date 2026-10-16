import type { StreamMessage } from "./types.js";

/**
 * Keep a turn's story ahead of its derived UI, regardless of SSE arrival order.
 * Early plugin surfaces move down behind the story rather than the story moving
 * up: a surface hydrated before the snapshot may sit ahead of the turn's player
 * message, which must stay first.
 */
export function orderStoryBeforePluginMessages(
  messages: StreamMessage[],
): StreamMessage[] {
  const pluginTurns = new Set<string>();
  const lastStoryIndex = new Map<string, number>();
  let needsMove = false;
  for (const [index, message] of messages.entries()) {
    if (!message.turnId) continue;
    if (message.kind === "plugin-message") pluginTurns.add(message.turnId);
    if (message.kind === "story") {
      lastStoryIndex.set(message.turnId, index);
      if (pluginTurns.has(message.turnId)) needsMove = true;
    }
  }
  if (!needsMove) return messages;

  const ordered: StreamMessage[] = [];
  const pending = new Map<string, StreamMessage[]>();
  for (const [index, message] of messages.entries()) {
    const turnId = message.turnId;
    if (
      turnId &&
      message.kind === "plugin-message" &&
      index < (lastStoryIndex.get(turnId) ?? -1)
    ) {
      const rows = pending.get(turnId) ?? [];
      rows.push(message);
      pending.set(turnId, rows);
      continue;
    }
    ordered.push(message);
    if (turnId && index === lastStoryIndex.get(turnId)) {
      for (const row of pending.get(turnId) ?? []) ordered.push(row);
      pending.delete(turnId);
    }
  }
  return ordered;
}
