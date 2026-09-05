import i18n from "i18next";
import * as api from "@/services/api";
import { ApiError } from "@/services/api/request.js";
import {
  SessionWorkspaceSyncError,
  type DataService,
  type SessionWorkspace,
} from "@/services/data-service.js";
import { emitToast } from "@/lib/toast-channel.js";
import { ignoreError } from "@/lib/ignore-error.js";
import type { MutableRef, SessionActionOwner } from "./runtime-refs.js";
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
 * its live runtimes as connection-closed. The owner guard also covers a newer
 * action in the same session while the previous workspace commit is pending.
 */
export function finalizeActionExecution(
  dispatch: SessionDispatch,
  streamSessionId: string | null | undefined,
  sessionIdRef: MutableRef<string | null>,
  isCurrentAction?: () => boolean,
): void {
  if (isCurrentAction && !isCurrentAction()) return;
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
    isCurrentAction?: () => boolean;
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let terminalReceived = false;
    let executionStarted = false;
    let recoveryRequired = false;
    let recoveryObserved = false;
    const isCurrent = () =>
      (!opts?.sessionIdRef ||
        opts.sessionIdRef.current === request.sessionId) &&
      (!opts?.isCurrentAction || opts.isCurrentAction());
    const observeUnfinishedAction = () => {
      if (
        (terminalReceived && !recoveryRequired) ||
        recoveryObserved ||
        !isCurrent()
      )
        return;
      recoveryObserved = true;
      dispatch({
        type: "SET_EXECUTION_RECOVERY",
        recovery: {
          sessionId: request.sessionId,
          status: null,
          checking: true,
          hydrating: false,
        },
      });
    };
    api.sendAction(
      request,
      (envelope) => {
        if (!isCurrent()) return;
        if (envelope.type === "execution.started") executionStarted = true;
        if (
          envelope.type === "execution.completed" ||
          envelope.type === "error.occurred"
        ) {
          terminalReceived = true;
          recoveryRequired =
            envelope.type === "execution.completed"
              ? envelope.payload.committed === false
              : executionStarted;
        }
        handleSseEvent(envelope);
        if (recoveryRequired) observeUnfinishedAction();
      },
      (err) => {
        // A broken transport cannot tell us whether the accepted action is
        // still running. Transfer observation to the read-only recovery poll.
        // A gateway/server 5xx can hide an accepted action. Only explicit 4xx
        // rejection proves that this request did not start another execution.
        const rejected =
          err instanceof ApiError && err.status >= 400 && err.status < 500;
        if (!rejected) observeUnfinishedAction();
        if (isCurrent() && (rejected || terminalReceived)) {
          dispatch({ type: "SET_EXECUTION_ERROR", error: err.message });
        }
        if (isCurrent() && opts?.toastOnError && rejected) {
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
        observeUnfinishedAction();
        resolve();
      },
    );
  });
}

export async function runSingleSessionAction({
  content,
  echoUserMessage,
  owner,
  session,
  ds,
  workspace,
  dispatch,
  handleSseEvent,
  sessionIdRef,
}: {
  content: string;
  echoUserMessage: boolean;
  owner: SessionActionOwner;
  session: api.SessionRecord;
  ds: DataService;
  workspace: SessionWorkspace;
  dispatch: SessionDispatch;
  handleSseEvent: SseEventHandler;
  sessionIdRef: MutableRef<string | null>;
}): Promise<void> {
  if (!owner.isCurrent()) return;
  dispatch({ type: "SET_EXECUTION_RECOVERY", recovery: null });
  if (echoUserMessage && content) {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    dispatch({
      type: "ADD_MESSAGE",
      message: { id, role: "user", content, timestamp },
    });
    try {
      await ds.addMessage({
        id,
        sessionId: session.id,
        role: "user",
        content,
        createdAt: timestamp,
      });
    } catch (error) {
      ignoreError("persist user message")(error);
      return;
    }
  }
  if (!owner.isCurrent()) return;
  try {
    await workspace.run(session.id, owner.requestId, () => {
      if (!owner.isCurrent())
        throw new Error("Action was superseded before execution");
      const base = {
        requestId: owner.requestId,
        sessionId: session.id,
        locale: session.locale ?? i18n.language,
      };
      const action: api.ActionRequest = content.startsWith("/")
        ? { ...base, type: "execute_command", payload: { command: content } }
        : { ...base, type: "send_message", payload: { content } };
      return runActionStream(action, handleSseEvent, dispatch, {
        toastOnError: true,
        sessionIdRef,
        isCurrentAction: owner.isCurrent,
      });
    });
  } catch (error) {
    if (owner.isCurrent()) reportWorkspaceSyncError(error, dispatch);
  }
}

/**
 * The server evolves SessionRecord during a turn (the phase/clock advances,
 * pre-game completion, status) but the SSE stream carries none of it —
 * without a resync the stage view's phase gate stays stale until a
 * full page reload.
 */
export async function resyncSessionRecord(
  sessionId: string,
  sessionIdRef: MutableRef<string | null>,
  dispatch: SessionDispatch,
  isCurrentAction?: () => boolean,
): Promise<void> {
  try {
    const session = await api.getSession(sessionId);
    // A stale response after a session switch must not overwrite the
    // now-active session's record (and yank the URL back to it).
    if (
      sessionIdRef.current !== sessionId ||
      (isCurrentAction && !isCurrentAction())
    )
      return;
    dispatch({ type: "SET_SESSION", session });
  } catch {
    /* next action or reload will resync */
  }
}
