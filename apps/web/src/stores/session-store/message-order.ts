import type { StreamMessage } from "./types.js";

/** Keep a turn's story ahead of its derived UI, regardless of SSE arrival order. */
export function orderStoryBeforePluginMessages(
  messages: StreamMessage[],
): StreamMessage[] {
  let ordered = messages;
  for (let index = 0; index < ordered.length; index += 1) {
    const story = ordered[index];
    if (story.kind !== "story" || !story.turnId) continue;
    const anchor = ordered.findIndex(
      (message) =>
        message.turnId === story.turnId && message.kind === "plugin-message",
    );
    if (anchor < 0 || anchor > index) continue;
    if (ordered === messages) ordered = [...messages];
    ordered.splice(index, 1);
    ordered.splice(anchor, 0, story);
  }
  return ordered;
}
