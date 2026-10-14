import {
  executionMayBeRunning,
  PLAYER_ABORT_REASON,
  type SessionExecutionStatus,
  type SessionSnapshot,
} from "@covel/shared";
import * as api from "@/services/api.js";
import {
  clearStreamingText,
  getStreamingText,
} from "@/stores/streaming-text-store.js";
import {
  publishSubmittedInteractions,
  toStreamMessages,
} from "./restore-session.js";
import {
  clearNarrativeDeltaBuffer,
  type DeltaBufferRef,
  type DeltaRafRef,
} from "./sse-handler.js";
import type { SessionDispatch, SessionState, StreamMessage } from "./types.js";

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
          !row.id.startsWith("stream_") &&
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

/** Clean only the narrative identities that this closed observation takes over. */
export function publishRecoveredMessages(
  dispatch: SessionDispatch,
  state: SessionState,
  snapshot: SessionSnapshot,
  execution: SessionExecutionStatus | undefined,
  mayTakeOver: boolean,
  deltaBufferRef: DeltaBufferRef,
  deltaRafRef: DeltaRafRef,
): void {
  const terminalTurnId =
    mayTakeOver && execution && !executionMayBeRunning(execution)
      ? execution.turnId
      : undefined;
  const messages = toStreamMessages(snapshot.messages);
  const unsavedNarratives: StreamMessage[] = [];
  if (
    terminalTurnId &&
    (execution?.state === "failed" || execution?.state === "interrupted") &&
    execution.abortReason !== PLAYER_ABORT_REASON
  ) {
    for (const row of state.messages) {
      if (
        row.turnId !== terminalTurnId ||
        !row.id.startsWith("stream_") ||
        messages.some(
          (saved) =>
            saved.turnId === row.turnId &&
            saved.runtimeId === row.runtimeId &&
            saved.kind === "story",
        )
      )
        continue;
      const bufferKey = `${terminalTurnId}_${row.runtimeId}`;
      const content =
        (getStreamingText(row.id) ?? row.content) +
        (deltaBufferRef.current.get(bufferKey)?.text ?? "");
      unsavedNarratives.push({ ...row, content });
      deltaBufferRef.current.delete(bufferKey);
      clearStreamingText(row.id);
    }
    // No queued chunk from this closed attempt may create a new placeholder.
    for (const [key, pending] of deltaBufferRef.current) {
      if (pending.turnId === terminalTurnId) deltaBufferRef.current.delete(key);
    }
  }
  if (terminalTurnId) {
    for (const message of messages) {
      if (
        message.turnId !== terminalTurnId ||
        !message.runtimeId ||
        message.kind !== "story"
      )
        continue;
      deltaBufferRef.current.delete(`${terminalTurnId}_${message.runtimeId}`);
      clearStreamingText(`stream_${terminalTurnId}_${message.runtimeId}`);
    }
    // A different live turn may still have a scheduled flush.
    if (deltaBufferRef.current.size === 0)
      clearNarrativeDeltaBuffer(deltaBufferRef, deltaRafRef);
  }
  publishSubmittedInteractions(dispatch, snapshot);
  dispatch({
    type: "MERGE_RECOVERED_MESSAGES",
    messages,
    terminalTurnId,
    unsavedNarratives,
    actionGeneration: state.actionGeneration ?? 0,
  });
}
