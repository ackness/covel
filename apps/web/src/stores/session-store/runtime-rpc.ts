import i18n from "i18next";
import {
  PLAYER_ABORT_REASON,
  type TurnAction,
  type TurnActionRequest,
} from "@covel/shared";
import * as api from "@/services/api";
import { ApiError } from "@/services/api/request.js";
import {
  SessionWorkspaceSyncError,
  type SessionWorkspace,
} from "@/services/data-service.js";
import { emitToast } from "@/lib/toast-channel.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { confirmPluginApproval } from "@/lib/approval-message.js";
import type { MutableRef, SessionActionOwner } from "./runtime-refs.js";
import type { SseEventHandler } from "./sse-handler.js";
import type { SessionDispatch } from "./types.js";
import { actionsText, echoContent } from "./composer-actions.js";
import { toExecutionStepStatus } from "./execution-steps.js";
import { refreshSessionResource } from "./session-resource-reads.js";

const CONNECTION_CLOSED_REASON = "__i18n:session.reasonConnectionClosed__";

/** Refresh grant-backed UI state even if the subsequent form/action is rejected. */
function refreshApprovedSessionPlugins(
  sessionId: string,
  dispatch: SessionDispatch,
  isCurrent: () => boolean,
): void {
  void api
    .listSessionPlugins(sessionId)
    .then((plugins) => {
      if (isCurrent())
        dispatch({
          type: "LOAD_SESSION_PLUGINS",
          plugins: [...plugins.items],
          commands: [...plugins.commands],
          unavailable: plugins.unavailable,
        });
    })
    .catch(ignoreError("refresh plugins after approval"));
}

/** The label explaining why the server withdrew an out-of-date suspension. */
function suspensionOutdatedDetailKey(details: unknown): string {
  const reason =
    details && typeof details === "object" && "reason" in details
      ? details.reason
      : undefined;
  if (reason === "plugin-updated") return "session.suspensionOutdatedPlugin";
  if (reason === "data-changed") return "session.suspensionOutdatedDataChanged";
  return "session.suspensionOutdatedMovedOn";
}

type ResumeOutcome =
  | { kind: "cancelled" }
  | { kind: "approval"; approval: api.ActionApproval }
  | ({ kind: "resumed" } & api.ResumeSuspensionResponse)
  | { kind: "outdated"; error: ApiError };

export async function resumeSessionSuspension(
  suspensionId: string,
  data: unknown,
  {
    workspace,
    sessionIdRef,
    sessionGenerationRef,
    dispatch,
    applyResumeEvents,
  }: {
    workspace: SessionWorkspace;
    sessionIdRef: MutableRef<string | null>;
    sessionGenerationRef: MutableRef<number>;
    dispatch: SessionDispatch;
    applyResumeEvents: (events: api.ResumeSuspensionResponse["events"]) => void;
  },
): Promise<void> {
  const sid = sessionIdRef.current;
  if (!sid) return;
  const generation = sessionGenerationRef.current;
  const isCurrent = () =>
    sessionIdRef.current === sid && sessionGenerationRef.current === generation;
  const requested = new Set<string>();
  while (isCurrent()) {
    // An outdated suspension is a settled result, so the workspace saves it.
    const outcome: ResumeOutcome = await workspace.run(
      sid,
      `resume:${crypto.randomUUID()}`,
      async () => {
        if (!isCurrent()) return { kind: "cancelled" as const };
        try {
          const result = await api.resumeSuspension(sid, suspensionId, data);
          return "status" in result
            ? { kind: "approval" as const, approval: result }
            : { kind: "resumed" as const, ...result };
        } catch (err) {
          if (err instanceof ApiError && err.code === "suspension_outdated")
            return { kind: "outdated" as const, error: err };
          throw err;
        }
      },
    );
    if (outcome.kind === "approval") {
      const approval: api.ActionApproval = outcome.approval;
      const key = JSON.stringify([
        approval.pending.pluginId,
        approval.pending.action,
      ]);
      if (approval.pending.sessionId !== sid || requested.has(key))
        throw new Error(i18n.t("plugin.approval.unexpectedRequired"));
      requested.add(key);
      // Never hold the workspace FIFO while waiting for the player.
      const allowed =
        isCurrent() &&
        (await confirmPluginApproval(approval.pending, {
          t: (key, options) => i18n.t(key, options) as string,
          confirm: requestConfirm,
        }));
      const approved = await workspace.run(
        sid,
        `resume-approval:${crypto.randomUUID()}`,
        async () => {
          const proceed = allowed && isCurrent();
          await api.resolveApproval(
            approval.approvalId,
            proceed ? "allow" : "deny",
            "session",
            sid,
          );
          if (proceed) refreshApprovedSessionPlugins(sid, dispatch, isCurrent);
          return proceed;
        },
      );
      if (!approved) return;
      continue;
    }
    if (!isCurrent() || outcome.kind === "cancelled") return;
    if (outcome.kind === "outdated") {
      dispatch({ type: "REMOVE_SUSPENSION", suspensionId });
      emitToast(
        "info",
        i18n.t("session.suspensionOutdated", {
          defaultValue: "This request is out of date and has been withdrawn",
        }) as string,
        i18n.t(suspensionOutdatedDetailKey(outcome.error.details), {
          defaultValue: "The story has moved on since it was asked.",
        }) as string,
      );
      await resyncSessionRecord(
        sid,
        sessionIdRef,
        dispatch,
        sessionGenerationRef,
        isCurrent,
      );
      return;
    }
    const { result, events } = outcome;
    applyResumeEvents(events);
    dispatch({
      type: "UPSERT_EXECUTION_STEP",
      step: {
        runtimeId: result.runtimeId,
        pluginId: result.pluginId,
        status: toExecutionStepStatus(result.status),
        turnId: result.turnId,
        ...(typeof result.durationMs === "number"
          ? { durationMs: result.durationMs }
          : {}),
        ...(result.error ? { detail: result.error } : {}),
      },
    });
    dispatch({ type: "REMOVE_SUSPENSION", suspensionId });
    // The last continuation can settle a player turn without any character
    // or dimension event. Read the committed clock instead of incrementing it.
    await resyncSessionRecord(
      sid,
      sessionIdRef,
      dispatch,
      sessionGenerationRef,
      isCurrent,
    );
    return;
  }
}

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
    let claimedTurn = false;
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
        // No turn was recorded: return this request's echo and avoid
        // adopting an unrelated earlier turn through the recovery poll.
        const stoppedBeforeStart =
          envelope.type === "execution.completed" &&
          envelope.payload.committed === false &&
          envelope.payload.abortReason === PLAYER_ABORT_REASON &&
          !executionStarted &&
          // Typed input only: an interaction answer has no echo to restore.
          request.type === "submit_actions" &&
          !request.payload.actions.some((action) => action.interaction);
        if (
          stoppedBeforeStart ||
          (envelope.type === "error.occurred" &&
            !executionStarted &&
            request.type === "submit_actions" &&
            !request.payload.actions.some((action) => action.interaction))
        ) {
          dispatch({
            type: "RESTORE_STOPPED_INPUT",
            requestId: request.requestId,
          });
          if (request.type === "submit_actions")
            dispatch({
              type: "RESTORE_ACTION_DRAFT",
              requestId: request.requestId,
              actions: request.payload.actions,
            });
        }
        if (!stoppedBeforeStart && !claimedTurn && envelope.turnId) {
          claimedTurn = true;
          dispatch({
            type: "BACKFILL_TURN_ID",
            turnId: envelope.turnId,
            requestId: request.requestId,
          });
        }
        if (envelope.type === "execution.started") executionStarted = true;
        if (
          envelope.type === "execution.completed" ||
          envelope.type === "error.occurred"
        ) {
          terminalReceived = true;
          recoveryRequired =
            envelope.type === "execution.completed"
              ? envelope.payload.resync === true ||
                (envelope.payload.committed === false && !stoppedBeforeStart)
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
      async (approval) => {
        const allowed =
          isCurrent() &&
          (await confirmPluginApproval(approval.pending, {
            t: (key, options) => i18n.t(key, options) as string,
            confirm: requestConfirm,
          }));
        const proceed = allowed && isCurrent();
        await api.resolveApproval(
          approval.approvalId,
          proceed ? "allow" : "deny",
          "session",
          request.sessionId,
        );
        if (proceed) {
          // A restart revokes community grants without changing activePlugins.
          // Refresh the visible activation state after restoring that grant.
          refreshApprovedSessionPlugins(request.sessionId, dispatch, isCurrent);
        }
        return proceed;
      },
    );
  });
}

export async function runSingleSessionAction({
  actions,
  echoActions,
  echoUserMessage,
  owner,
  session,
  workspace,
  dispatch,
  handleSseEvent,
  sessionIdRef,
}: {
  actions: readonly TurnActionRequest[];
  /** The actions as the server will resolve them, kept on the echoed message. */
  echoActions?: readonly TurnAction[];
  echoUserMessage: boolean;
  owner: SessionActionOwner;
  session: api.SessionRecord;
  workspace: SessionWorkspace;
  dispatch: SessionDispatch;
  handleSseEvent: SseEventHandler;
  sessionIdRef: MutableRef<string | null>;
}): Promise<void> {
  if (!owner.isCurrent()) return;
  dispatch({ type: "SET_EXECUTION_RECOVERY", recovery: null });
  let input: api.MessageRecord | undefined;
  let inputMessageId: string | undefined;
  const content = echoContent(actions);
  if (echoUserMessage && content) {
    const id = crypto.randomUUID();
    inputMessageId = id;
    const timestamp = new Date().toISOString();
    dispatch({
      type: "ADD_MESSAGE",
      message: {
        id,
        role: "user",
        content,
        timestamp,
        requestId: owner.requestId,
        ...(echoActions ? { actions: echoActions } : {}),
      },
    });
    // The browser stores the input before the commit, and the commit adopts
    // that row only when the content is identical. The server's content is
    // the actions' texts; a fields-only action gets a labelled rendering that
    // only the server can produce, so it is committed under the same id with
    // no row stored ahead of it.
    if (actionsText(actions) === content) {
      input = {
        id,
        sessionId: session.id,
        role: "user",
        content,
        createdAt: timestamp,
      };
    }
  }
  if (!owner.isCurrent()) return;
  let started = false;
  try {
    await workspace.run(
      session.id,
      owner.requestId,
      () => {
        if (!owner.isCurrent())
          throw new Error("Action was superseded before execution");
        const base = {
          requestId: owner.requestId,
          sessionId: session.id,
        };
        // No seat is named: the server takes the primary seat and its
        // current character.
        const action: api.ActionRequest = {
          ...base,
          type: "submit_actions",
          payload: {
            actions: [...actions],
            ...(inputMessageId ? { inputMessageId } : {}),
          },
        };
        return runActionStream(
          action,
          (event) => {
            if (event.type === "execution.started") started = true;
            handleSseEvent(event);
          },
          dispatch,
          {
            toastOnError: true,
            sessionIdRef,
            isCurrentAction: owner.isCurrent,
          },
        );
      },
      { input, isCurrent: owner.isCurrent },
    );
  } catch (error) {
    if (owner.isCurrent()) {
      reportWorkspaceSyncError(error, dispatch);
      if (!started) {
        dispatch({ type: "RESTORE_STOPPED_INPUT", requestId: owner.requestId });
        dispatch({
          type: "RESTORE_ACTION_DRAFT",
          requestId: owner.requestId,
          actions,
        });
      }
    }
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
  sessionGenerationRef: MutableRef<number>,
  isCurrentAction?: () => boolean,
): Promise<void> {
  const generation = sessionGenerationRef.current;
  try {
    await refreshSessionResource(dispatch, ["game-state", sessionId], {
      isCurrent: () =>
        sessionIdRef.current === sessionId &&
        sessionGenerationRef.current === generation &&
        (!isCurrentAction || isCurrentAction()),
      read: () => api.getSession(sessionId),
      apply: (session) => dispatch({ type: "SET_SESSION", session }),
    });
  } catch {
    /* next action or reload will resync */
  }
}
