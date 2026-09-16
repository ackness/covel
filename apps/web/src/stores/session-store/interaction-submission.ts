import * as api from "@/services/api.js";
import i18n from "i18next";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { resolvePluginRpcApprovalResponse } from "@/components/session/plugin-rpc-ui.js";
import type { SessionWorkspace } from "@/services/data-service.js";
import type { SessionActions } from "./context.js";
import { enrichGameStateFromSnapshot } from "./game-state.js";
import type { MutableRef, SessionActionOwner } from "./runtime-refs.js";
import type { SessionDispatch } from "./types.js";
import {
  finalizeActionExecution,
  reportWorkspaceSyncError,
  refreshApprovedSessionPlugins,
} from "./runtime-rpc.js";

interface SubmissionDependencies {
  dispatch: SessionDispatch;
  workspace: Pick<SessionWorkspace, "run">;
  sessionIdRef: MutableRef<string | null>;
  submitBlock: SessionActions["submitBlock"];
  runSingleAction: (
    content: string,
    options: { echoUserMessage: boolean; owner: SessionActionOwner },
  ) => Promise<void>;
  resyncSession: (sessionId: string, isCurrentAction?: () => boolean) => void;
  claimAction: (sessionId: string) => SessionActionOwner;
  inFlight: Set<string>;
}

/** Failed validation leaves the form editable; it must never become free text. */
export async function submitInteractionBlock(
  deps: SubmissionDependencies,
  submission: Parameters<SessionActions["submitInteraction"]>,
): Promise<void> {
  const [blockId, turnId, interactionId, type, values, submitBehavior] =
    submission;
  const { dispatch, sessionIdRef, inFlight } = deps;
  const sid = sessionIdRef.current;
  if (!sid) return;
  const key = `${sid}:${blockId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const owner = deps.claimAction(sid);
  let started = false;
  try {
    const result = await deps.workspace.run(
      sid,
      `interaction:${owner.requestId}`,
      () => {
        if (!owner.isCurrent())
          throw new Error("Action was superseded before submission");
        return api.submitInputs(
          sid,
          {
            turnId,
            submissions: [{ interactionId, type, values }],
          },
          (response, retry) =>
            resolvePluginRpcApprovalResponse({
              response,
              sessionId: sid,
              pluginId: "framework",
              actionLabel: "submit-form",
              t: (key, options) => i18n.t(key, options),
              confirm: async (request) =>
                owner.isCurrent() &&
                (await requestConfirm(request)) &&
                owner.isCurrent(),
              retry: () => {
                if (!owner.isCurrent())
                  throw new Error("Action was superseded before submission");
                return retry();
              },
              submitApproval: async (...args) => {
                await api.resolveApproval(...args);
                if (args[1] === "allow")
                  refreshApprovedSessionPlugins(sid, dispatch, owner.isCurrent);
              },
            }),
        );
      },
    );
    if (!result || !owner.isCurrent()) return;
    if (
      !result.results.find((item) => item.interactionId === interactionId)
        ?.accepted
    ) {
      throw new Error(
        "The form was not accepted. Review the values and submit again.",
      );
    }
    deps.submitBlock(blockId, values);
    const filled = result.results?.[0]?.filledNarrative ?? "";
    const echo = submitBehavior?.echoFilledNarrative !== false;
    started = true;
    dispatch({ type: "SET_EXECUTING", value: true });
    dispatch({ type: "SET_EXECUTION_ERROR", error: null });
    await deps.runSingleAction(echo ? filled : "", {
      echoUserMessage: echo && Boolean(filled),
      owner,
    });
    if (!owner.isCurrent()) return;
    try {
      const snapshot = await api.getSessionView(sid);
      if (owner.isCurrent()) {
        dispatch({
          type: "SET_GAME_STATE",
          state: enrichGameStateFromSnapshot(snapshot),
        });
      }
    } catch {
      // Reconnect will reconcile the character schema if this refresh fails.
    }
  } catch (error) {
    if (!owner.isCurrent()) return;
    if (!reportWorkspaceSyncError(error, dispatch)) {
      dispatch({
        type: "SET_EXECUTION_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    inFlight.delete(key);
    if (started) {
      finalizeActionExecution(dispatch, sid, sessionIdRef, owner.isCurrent);
      if (owner.isCurrent()) deps.resyncSession(sid, owner.isCurrent);
    }
  }
}
