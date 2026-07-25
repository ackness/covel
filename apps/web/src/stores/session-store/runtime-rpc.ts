import i18n from "i18next";
import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import { emitToast } from "@/lib/toast-channel.js";
import type { MutableRef } from "./runtime-refs.js";
import type { SseEventHandler } from "./sse-handler.js";
import type { SessionDispatch } from "./types.js";

const CONNECTION_CLOSED_REASON = "__i18n:session.reasonConnectionClosed__";

/**
 * Settle the executing flag once an action stream ends.
 *
 * `streamSessionId` is the session the stream was opened for. A stream is not
 * aborted when the player switches sessions mid-turn, so without this guard the
 * old stream's completion would clear the NEW session's executing flag and mark
 * its live runtimes as connection-closed.
 */
export function finalizeActionExecution(
  dispatch: SessionDispatch,
  streamSessionId: string | null | undefined,
  sessionIdRef: MutableRef<string | null>,
): void {
  const currentSessionId = sessionIdRef.current;
  if (
    streamSessionId &&
    currentSessionId &&
    streamSessionId !== currentSessionId
  ) {
    return;
  }
  dispatch({ type: "SET_EXECUTING", value: false });
  dispatch({
    type: "FINALIZE_HANGING_RUNTIMES",
    reason: CONNECTION_CLOSED_REASON,
  });
}

export function runActionStream(
  request: api.ActionRequest,
  handleSseEvent: SseEventHandler,
  dispatch: SessionDispatch,
  opts?: { toastOnError?: boolean },
): Promise<void> {
  return new Promise<void>((resolve) => {
    api.sendAction(
      request,
      handleSseEvent,
      (err) => {
        dispatch({ type: "SET_EXECUTION_ERROR", error: err.message });
        if (opts?.toastOnError) {
          emitToast(
            "error",
            i18n.t("toast.sendMessageFailed", {
              defaultValue: "Failed to send message",
            }) as string,
            err.message,
          );
        }
        resolve();
      },
      () => {
        resolve();
      },
    );
  });
}

/**
 * Rebuild the server's session context if needed, then run the action.
 *
 * If the context sync fails the action is NOT fired: the kernel would build
 * its prompt from an empty server-side history and the player would watch the
 * narrator forget the story with nothing on screen explaining why. `onAborted`
 * lets the caller settle whatever state it had already put in flight.
 */
export function ensureServerThenRun(
  ds: DataService,
  sessionId: string,
  fireAction: () => void,
  onAborted?: () => void,
): void {
  api
    .ensureServerSession(sessionId, (sid) => ds.syncToServer(sid))
    .then(fireAction)
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[session] server context sync failed:", err);
      emitToast(
        "error",
        i18n.t("toast.syncFailed", {
          defaultValue: "Could not sync this session to the server",
        }) as string,
        detail,
      );
      onAborted?.();
    });
}
