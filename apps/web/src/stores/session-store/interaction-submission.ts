import * as api from "@/services/api.js";
import { ApiError } from "@/services/api/request.js";
import type { SessionWorkspace } from "@/services/data-service.js";
import type { SessionActions } from "./context.js";
import {
  enrichGameStateFromSnapshot,
  publishSessionGameState,
} from "./game-state.js";
import { publishSubmittedInteractions } from "./restore-session.js";
import { refreshSessionResource } from "./session-resource-reads.js";
import type { MutableRef, SessionActionOwner } from "./runtime-refs.js";
import type { SseEventHandler } from "./sse-handler.js";
import type {
  FormIssue,
  InteractionSubmitResult,
  SessionDispatch,
  SessionState,
} from "./types.js";
import { canRunSessionAction } from "./selectors.js";
import {
  finalizeActionExecution,
  reportWorkspaceSyncError,
  runActionStream,
} from "./runtime-rpc.js";

interface SubmissionDependencies {
  dispatch: SessionDispatch;
  workspace: Pick<SessionWorkspace, "run">;
  sessionIdRef: MutableRef<string | null>;
  stateRef: MutableRef<SessionState>;
  handleSseEvent: SseEventHandler;
  resyncSession: (sessionId: string, isCurrentAction?: () => boolean) => void;
  claimAction: (sessionId: string) => SessionActionOwner;
  inFlight: Set<string>;
}

/** The refusal's issues, or the whole message as one form-level issue. */
function readFormIssues(
  payload: Readonly<Record<string, unknown>>,
): FormIssue[] {
  const raw = (payload.details as { issues?: unknown } | undefined)?.issues;
  const issues: FormIssue[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const { field, message } = item as Record<string, unknown>;
      if (typeof message !== "string" || !message) continue;
      issues.push(
        typeof field === "string" && field ? { field, message } : { message },
      );
    }
  }
  return issues.length > 0 ? issues : [{ message: String(payload.message) }];
}

/**
 * Sends the answer as one `submit_interaction` action: the server stores it
 * and runs the follow-up turn on the same stream, so there is no moment where
 * the answer is stored and its turn was never asked for.
 *
 * A refusal of the values settles with `rejected` and leaves the form
 * editable, with each message under its field; it must never become free
 * text.
 */
export async function submitInteractionBlock(
  deps: SubmissionDependencies,
  submission: Parameters<SessionActions["submitInteraction"]>,
): Promise<InteractionSubmitResult> {
  const [blockId, turnId, interactionId, type, values] = submission;
  const { dispatch, sessionIdRef, inFlight } = deps;
  const sid = sessionIdRef.current;
  if (!sid || !canRunSessionAction(deps.stateRef.current)) return;
  const key = `${sid}:${blockId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const owner = deps.claimAction(sid);
  let rejected: FormIssue[] | undefined;
  let answeredElsewhere: string | undefined;
  let stored = false;

  const onEvent: SseEventHandler = (envelope) => {
    if (envelope.type === "interaction.submitted") {
      // The answer is stored and its turn has started: from here on the
      // stream is an ordinary turn.
      stored = true;
      const results = envelope.payload.results as
        | { interactionId: string; values: Record<string, unknown> }[]
        | undefined;
      dispatch({
        type: "SUBMIT_BLOCK",
        blockId,
        values:
          results?.find((item) => item.interactionId === interactionId)
            ?.values ?? values,
      });
      const message = envelope.payload.message as
        { id: string; content: string } | undefined;
      // The id is the stored message's, so the reload after the turn
      // replaces this echo and does not add a second row.
      if (message?.content)
        dispatch({
          type: "ADD_MESSAGE",
          message: {
            id: message.id,
            role: "user",
            content: message.content,
            timestamp: envelope.timestamp,
            turnId: envelope.turnId,
          },
        });
      return;
    }
    if (envelope.type === "error.occurred" && !stored) {
      // Both refusals are written for the player, in the session's language.
      // Nothing was stored and no turn started.
      if (envelope.payload.code === "form_rejected") {
        rejected = readFormIssues(envelope.payload);
        return;
      }
      if (envelope.payload.code === "interaction_already_submitted") {
        answeredElsewhere = String(envelope.payload.message);
        return;
      }
    }
    deps.handleSseEvent(envelope);
  };

  dispatch({ type: "SET_EXECUTION_RECOVERY", recovery: null });
  dispatch({ type: "SET_EXECUTING", value: true });
  dispatch({ type: "SET_EXECUTION_ERROR", error: null });
  try {
    await deps.workspace.run(
      sid,
      owner.requestId,
      () => {
        if (!owner.isCurrent())
          throw new Error("Action was superseded before submission");
        return runActionStream(
          {
            requestId: owner.requestId,
            sessionId: sid,
            type: "submit_interaction",
            payload: {
              turnId,
              submissions: [{ interactionId, type, values }],
            },
          },
          onEvent,
          dispatch,
          { sessionIdRef, isCurrentAction: owner.isCurrent },
        );
      },
      { isCurrent: owner.isCurrent },
    );
    if (!owner.isCurrent()) return;
    if (rejected) return { rejected };
    if (answeredElsewhere) {
      // Answered in another tab or by a request whose response was lost. Say
      // so, mark the block from the server's record, and watch the turn that
      // answer started instead of sending it again.
      dispatch({ type: "SET_EXECUTION_ERROR", error: answeredElsewhere });
      dispatch({
        type: "SET_EXECUTION_RECOVERY",
        recovery: {
          sessionId: sid,
          status: null,
          checking: true,
          hydrating: false,
        },
      });
      void refreshSessionResource(dispatch, ["game-state", sid, "answered"], {
        isCurrent: owner.isCurrent,
        read: () => api.getSessionView(sid),
        apply: (snapshot) => publishSubmittedInteractions(dispatch, snapshot),
      }).catch(() => {});
      return;
    }
    if (!stored) return;
    try {
      await refreshSessionResource(
        dispatch,
        ["game-state", sid, "interaction"],
        {
          isCurrent: owner.isCurrent,
          read: () => api.getSessionView(sid),
          apply: (snapshot) =>
            publishSessionGameState(
              dispatch,
              sid,
              enrichGameStateFromSnapshot(snapshot),
            ),
        },
      );
    } catch {
      // Reconnect will reconcile the character schema if this refresh fails.
    }
  } catch (error) {
    // The stream runner already reported a failed request and handed an
    // unfinished turn to the recovery poll.
    if (!owner.isCurrent()) return;
    if (error instanceof ApiError && error.code === "plugin_approval_denied") {
      // The player declined to load the form provider's code. That is their
      // answer, not a failure: the form stays as it is.
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });
    } else {
      reportWorkspaceSyncError(error, dispatch);
    }
  } finally {
    inFlight.delete(key);
    finalizeActionExecution(dispatch, sid, sessionIdRef, owner.isCurrent);
    if (stored && owner.isCurrent()) deps.resyncSession(sid, owner.isCurrent);
  }
}
