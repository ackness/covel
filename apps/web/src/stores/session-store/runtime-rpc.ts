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
  opts?: {
    toastOnError?: boolean;
    sessionIdRef?: MutableRef<string | null>;
    dataService?: DataService;
  },
): Promise<void> {
  return new Promise<void>((resolve) => {
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
        resolve();
      },
      () => {
        const persist = opts?.dataService
          ? opts.dataService.commitFromServer(
              request.sessionId,
              request.requestId,
            )
          : Promise.resolve();
        persist
          .catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            dispatch({ type: "SET_EXECUTION_ERROR", error: detail });
            emitToast(
              "error",
              i18n.t("toast.syncFailed", {
                defaultValue: "Could not persist this turn in the browser",
              }) as string,
              detail,
            );
          })
          .finally(resolve);
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
  opts?: {
    onAborted?: () => void;
    sessionIdRef?: MutableRef<string | null>;
  },
): void {
  ds.syncToServer(sessionId)
    .then(() => {
      if (opts?.sessionIdRef && opts.sessionIdRef.current !== sessionId) {
        opts.onAborted?.();
        return;
      }
      fireAction();
    })
    .catch((err: unknown) => {
      if (opts?.sessionIdRef && opts.sessionIdRef.current !== sessionId) {
        opts.onAborted?.();
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[session] server context sync failed:", err);
      emitToast(
        "error",
        i18n.t("toast.syncFailed", {
          defaultValue: "Could not sync this session to the server",
        }) as string,
        detail,
      );
      opts?.onAborted?.();
    });
}

/**
 * Run a non-streaming session mutation against the transient browser-private
 * workspace and immediately checkpoint its result. Remote mode implements the
 * surrounding sync/commit calls as no-ops, so callers use one path in both
 * deployment profiles.
 */
export async function runWorkspaceMutation<T>(
  ds: DataService,
  sessionId: string,
  actionId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  await ds.syncToServer(sessionId);
  const result = await mutate();
  await ds.commitFromServer(sessionId, actionId);
  return result;
}
