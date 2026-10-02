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
  let ordered = messages;
  for (let index = 0; index < ordered.length; index += 1) {
    const story = ordered[index];
    if (story.kind !== "story" || !story.turnId) continue;
    const early = ordered
      .slice(0, index)
      .filter(
        (message) =>
          message.turnId === story.turnId && message.kind === "plugin-message",
      );
    if (early.length === 0) continue;
    const moved = new Set(early);
    const before = ordered.slice(0, index).filter((m) => !moved.has(m));
    ordered = [...before, story, ...early, ...ordered.slice(index + 1)];
    index = before.length;
  }
  return ordered;
}
