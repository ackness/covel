import i18n from "i18next";
import * as api from "@/services/api";
import { SessionWorkspaceSyncError } from "@/services/data-service.js";
import { emitToast } from "@/lib/toast-channel.js";
import type { MutableRef } from "./runtime-refs.js";
import type { SseEventHandler } from "./sse-handler.js";
import type { SessionDispatch } from "./types.js";

const CONNECTION_CLOSED_REASON = "__i18n:session.reasonConnectionClosed__";

export function reportWorkspaceSyncError(
  error: unknown,
  dispatch: SessionDispatch,
): error is SessionWorkspaceSyncError {
  if (!(error instanceof SessionWorkspaceSyncError)) return false;
  const detail =
    error.cause instanceof Error ? error.cause.message : String(error.cause);
  console.error(`[session] workspace ${error.stage} failed:`, error.cause);
  dispatch({ type: "SET_EXECUTION_ERROR", error: detail });
  emitToast(
    "error",
    i18n.t("toast.syncFailed", {
      defaultValue: "Could not sync this session to the server",
    }) as string,
    detail,
  );
  return true;
}

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
  opts?: {
    toastOnError?: boolean;
    sessionIdRef?: MutableRef<string | null>;
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    api.sendAction(
      request,
      (envelope) => {
        if (
          opts?.sessionIdRef &&
          opts.sessionIdRef.current !== request.sessionId
        ) {
          return;
        }
        handleSseEvent(envelope);
      },
      (err) => {
        const isCurrent =
          !opts?.sessionIdRef ||
          opts.sessionIdRef.current === request.sessionId;
        if (isCurrent) {
          dispatch({ type: "SET_EXECUTION_ERROR", error: err.message });
        }
        if (isCurrent && opts?.toastOnError) {
          emitToast(
            "error",
            i18n.t("toast.sendMessageFailed", {
              defaultValue: "Failed to send message",
            }) as string,
            err.message,
          );
        }
        reject(err);
      },
      () => {
        resolve();
      },
    );
  });
}
