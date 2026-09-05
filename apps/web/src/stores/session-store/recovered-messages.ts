import { orderStoryBeforePluginMessages } from "./message-order.js";
import type { StreamMessage } from "./types.js";

const isStream = (message: StreamMessage) => message.id.startsWith("stream_");

/** Fill reconnect gaps without replacing live text or the loaded history window. */
export function mergeRecoveredMessages(
  current: StreamMessage[],
  recovered: StreamMessage[],
  executing: boolean,
): StreamMessage[] {
  if (recovered.length === 0) return current;
  const messages = [...current];
  let previous = -1;
  for (let index = 0; index < recovered.length; index += 1) {
    const message = recovered[index];
    const existing = messages.findIndex((row) => row.id === message.id);
    if (existing >= 0) {
      // A later live completion may have arrived while the snapshot was read.
      previous = existing;
      continue;
    }
    const stream =
      message.turnId && message.runtimeId && message.kind === "story"
        ? messages.findIndex(
            (row) =>
              isStream(row) &&
              row.turnId === message.turnId &&
              row.runtimeId === message.runtimeId,
          )
        : -1;
    if (stream >= 0) {
      // Keep an active attempt intact; a closed attempt can recover its full text.
      if (!executing) messages[stream] = message;
      previous = stream;
      continue;
    }

    let insertion = previous >= 0 ? previous + 1 : -1;
    if (insertion < 0) {
      // The next shared ID is an ordering anchor even if its local clock differs.
      for (const following of recovered.slice(index + 1)) {
        const next = messages.findIndex((row) => row.id === following.id);
        if (next >= 0) {
          insertion = next;
          break;
        }
      }
    }
    if (insertion < 0 && message.turnId) {
      const sameTurn = messages.findIndex(
        (row) => row.turnId === message.turnId,
      );
      if (sameTurn >= 0) {
        insertion = sameTurn;
        if (message.role !== "user" && messages[sameTurn].role === "user")
          insertion += 1;
      }
    }
    if (insertion < 0) {
      // With no overlap, retain existing row order and place only the missing
      // durable row. Streaming/client-pending tails never act as clock anchors.
      insertion = messages.findIndex(
        (row) =>
          isStream(row) ||
          (row.role === "user" && !row.turnId) ||
          (row.kind !== "plugin-message" && row.timestamp > message.timestamp),
      );
    }
    if (insertion < 0) insertion = messages.length;
    messages.splice(insertion, 0, message);
    previous = insertion;
  }
  return orderStoryBeforePluginMessages(messages);
}
