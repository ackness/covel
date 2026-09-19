import { randomUUID } from "node:crypto";
import type {
  DataStore,
  MessageRecord,
  SnapshotRecord,
  SnapshotPayload,
} from "@covel/store";

/** Rolls back the child when a captured conversation boundary is unavailable. */
export class ForkCursorMissingError extends Error {}

export async function readForkDisplayMessages(
  store: Pick<DataStore, "listMessages">,
  parentSessionId: string,
  snapshot: SnapshotRecord,
): Promise<MessageRecord[]> {
  const boundary = snapshot.payload.displayMessagesBoundary;
  if (boundary === null) return [];
  const messages = await store.listMessages(parentSessionId);
  const ids = new Set(boundary.ids);
  const present = new Set(
    messages
      .filter((message) => message.createdAt === boundary.createdAt)
      .map((message) => message.id),
  );
  if (boundary.ids.some((id) => !present.has(id)))
    throw new ForkCursorMissingError();
  const visible = messages.filter(
    (message) => message.createdAt < boundary.createdAt || ids.has(message.id),
  );
  // Match the UI's keyset ordering, including on MemoryStore.
  return visible.sort((a, b) =>
    a.createdAt < b.createdAt
      ? -1
      : a.createdAt > b.createdAt
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
}

export async function copyForkDisplayMessages(
  store: Pick<DataStore, "listMessages" | "addMessage">,
  parentSessionId: string,
  childSessionId: string,
  snapshot: SnapshotRecord,
): Promise<{
  messages: MessageRecord[];
  boundary: SnapshotPayload["displayMessagesBoundary"];
}> {
  const messages = await readForkDisplayMessages(
    store,
    parentSessionId,
    snapshot,
  );
  // One random prefix and ordered suffixes preserve same-time UI ordering
  // while keeping ids distinct from both parent and siblings.
  const prefix = randomUUID();
  const ids = new Map<string, string>();
  for (const [index, message] of messages.entries()) {
    const id = `${prefix}-${String(index).padStart(12, "0")}`;
    ids.set(message.id, id);
    await store.addMessage({ ...message, id, sessionId: childSessionId });
  }
  const last = messages.at(-1);
  return {
    messages,
    boundary: last
      ? {
          createdAt: last.createdAt,
          ids: messages
            .filter((message) => message.createdAt === last.createdAt)
            .map((message) => ids.get(message.id)!),
        }
      : null,
  };
}
