import { type SessionSnapshot } from "@covel/shared";
import * as api from "@/services/api.js";
import {
  publishSubmittedInteractions,
  toStreamMessages,
} from "./restore-session.js";
import type { SessionDispatch, StreamMessage } from "./types.js";

/** Shown to the player; the cause goes to the console. */
export class RecoveredMessageWindowError extends Error {
  constructor(cause: unknown) {
    super("__i18n:session.reasonHistoryRestoreFailed__", { cause });
    this.name = "RecoveredMessageWindowError";
  }
}

/** A recent snapshot must connect to loaded durable history before publication. */
export async function readRecoveredSnapshot(
  sessionId: string,
  current: readonly StreamMessage[],
  isCurrent: () => boolean,
): Promise<SessionSnapshot> {
  const loadedIds = new Set(
    current
      .filter(
        (row) =>
          row.kind !== "plugin-message" &&
          !(row.role === "user" && !row.turnId),
      )
      .map((row) => row.id),
  );
  const snapshot = await api
    .getSessionView(sessionId)
    .catch((error: unknown) => {
      throw new RecoveredMessageWindowError(error);
    });
  let messages = [...snapshot.messages];
  let cursor = snapshot.messagesCursor;
  const seenCursors = new Set<string>();
  const connected = () => messages.some((row) => loadedIds.has(row.id));
  while (isCurrent() && loadedIds.size > 0 && cursor && !connected()) {
    if (seenCursors.has(cursor))
      throw new RecoveredMessageWindowError("pagination did not advance");
    seenCursors.add(cursor);
    const page = await api
      .listMessagesPage(sessionId, { cursor, limit: 40 })
      .catch((error: unknown) => {
        throw new RecoveredMessageWindowError(error);
      });
    if (!isCurrent()) return snapshot;
    const ids = new Set(messages.map((row) => row.id));
    const older = page.items.filter((row) => {
      if (ids.has(row.id)) return false;
      ids.add(row.id);
      return true;
    });
    messages = [...older, ...messages];
    if (!connected() && page.nextCursor && older.length === 0)
      throw new RecoveredMessageWindowError("pagination did not advance");
    cursor = page.nextCursor;
  }
  return { ...snapshot, messages };
}

/** Publish complete committed rows; recovery never manufactures a draft. */
export function publishRecoveredMessages(
  dispatch: SessionDispatch,
  snapshot: SessionSnapshot,
): void {
  publishSubmittedInteractions(dispatch, snapshot);
  dispatch({
    type: "MERGE_RECOVERED_MESSAGES",
    messages: toStreamMessages(snapshot.messages),
  });
}
