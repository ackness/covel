import { projectStoryOperationFailures } from "@covel/shared";
import { orderStoryBeforePluginMessages } from "./message-order.js";
import type { StreamMessage } from "./types.js";

/** Fill reconnect gaps without replacing live text or the loaded history window. */
export function mergeRecoveredMessages(
  current: StreamMessage[],
  recovered: StreamMessage[],
): StreamMessage[] {
  if (recovered.length === 0) return current;
  let messages = current;
  const byId = new Map(current.map((row, index) => [row.id, index]));
  const writable = () => {
    if (messages === current) messages = [...current];
    return messages;
  };
  const replace = (index: number, message: StreamMessage) => {
    const previous = messages[index];
    if (previous === message) return;
    if (previous) byId.delete(previous.id);
    writable()[index] = message;
    byId.set(message.id, index);
  };
  const recoveredIds = new Set(recovered.map((message) => message.id));
  let previous = -1;
  for (const [index, message] of recovered.entries()) {
    const existing = byId.get(message.id) ?? -1;
    if (existing >= 0) {
      const row = messages[existing];
      // A durable same-ID row replaces the client timestamp and echo marker.
      if (row?.requestId) replace(existing, message);
      // A completed story without segments takes the committed speakers; its
      // text and ownership stay with the live row. A player message shown
      // without its actions takes the committed ones, so its bubble names the
      // acting character.
      else if (row) {
        const segments =
          !row.segments && message.segments
            ? { segments: message.segments }
            : {};
        const actions =
          !row.actions && message.actions ? { actions: message.actions } : {};
        const notice =
          row.role === "assistant" &&
          row.kind === "story" &&
          !row.operationFailures
            ? projectStoryOperationFailures(message)
            : {};
        if (segments.segments || actions.actions || notice.operationFailures)
          replace(existing, { ...row, ...segments, ...actions, ...notice });
      }
      // A later live completion may have arrived while the snapshot was read.
      previous = existing;
      continue;
    }
    // Player echoes receive the turn ID from execution.started, but the server
    // allocates their durable message IDs. Reconcile each echo once; identical
    // steering messages and inputs in other turns must retain their own rows.
    const echo =
      message.role === "user" && message.turnId
        ? messages.findIndex(
            (row) =>
              row.role === "user" &&
              row.turnId === message.turnId &&
              row.content === message.content &&
              !recoveredIds.has(row.id),
          )
        : -1;
    if (echo >= 0) {
      replace(echo, message);
      previous = echo;
      continue;
    }
    let insertion = previous >= 0 ? previous + 1 : -1;
    if (insertion < 0) {
      // The next shared ID is an ordering anchor even if its local clock differs.
      for (const following of recovered.slice(index + 1)) {
        const next = byId.get(following.id) ?? -1;
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
        if (message.role !== "user" && messages[sameTurn]?.role === "user")
          insertion += 1;
      }
    }
    if (insertion < 0) {
      // With no overlap, retain existing row order and place only the missing
      // durable row. Client-pending tails never act as clock anchors.
      insertion = messages.findIndex(
        (row) =>
          (row.role === "user" && !row.turnId) ||
          (row.kind !== "plugin-message" && row.timestamp > message.timestamp),
      );
    }
    if (insertion < 0) insertion = messages.length;
    writable().splice(insertion, 0, message);
    for (let position = insertion; position < messages.length; position += 1)
      byId.set(messages[position]!.id, position);
    previous = insertion;
  }
  return orderStoryBeforePluginMessages(messages);
}
