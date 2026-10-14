import { randomUUID } from "node:crypto";
import type {
  DataStore,
  MessageRecord,
  SnapshotRecord,
  SnapshotPayload,
} from "@covel/store";

/** Rolls back the child when a captured conversation boundary is unavailable. */
export class ForkCursorMissingError extends Error {}

async function readForkDisplayMessages(
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
  // listMessages already orders timestamp ties by write position. Keep that
  // order when assigning new IDs and writing the child history.
  return messages.filter(
    (message) => message.createdAt < boundary.createdAt || ids.has(message.id),
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
  // Keep IDs distinct from both parent and siblings. The insertion sequence
  // below, rather than the IDs themselves, preserves same-time display order.
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
