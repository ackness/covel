import { useEffect, useRef } from "react";
import * as api from "@/services/api";
import { ignoreError } from "@/lib/ignore-error.js";
import {
  createSessionSubscription,
  type ConnectionState,
  type SessionSubscription,
  type SubscriptionEvent,
} from "@/services/subscription.js";
import { setConnectionState } from "@/stores/connection-store.js";
import {
  applyChanges as applyPluginDataStoreChanges,
  type PluginDataChange,
} from "@/stores/plugin-data-store.js";
import { buildResumedExecutionStep } from "./execution-steps.js";
import { enrichGameStateFromSnapshot } from "./game-state.js";
import {
  collectJobTransitions,
  emitJobTransitionToast,
} from "./job-transitions.js";
import type { SessionAction, SuspensionRecord } from "./types.js";

interface MutableRef<T> {
  current: T;
}

interface UseSessionSubscriptionOptions {
  sessionId: string | null | undefined;
  dispatch: (action: SessionAction) => void;
  sessionIdRef: MutableRef<string | null>;
}

function createSubscriptionEventHandler(
  options: Pick<UseSessionSubscriptionOptions, "dispatch" | "sessionIdRef">,
) {
  return (event: SubscriptionEvent): void => {
    switch (event.type) {
      case "plugin.activated":
      case "plugin.deactivated": {
        const currentSid = options.sessionIdRef.current;
        if (currentSid) {
          api
            .listSessionPlugins(currentSid)
            .then((res) =>
              options.dispatch({
                type: "LOAD_SESSION_PLUGINS",
                plugins: res.available,
              }),
            )
            .catch(ignoreError("reload session plugins on plugin toggle"));
        }
        break;
      }
      case "world.dimensions.changed": {
        const worldId = event.payload?.worldId as string | undefined;
        if (worldId) {
          api
            .getWorld(worldId)
            .then((world) => options.dispatch({ type: "UPDATE_WORLD", world }))
            .catch(ignoreError("refresh world on dimensions changed"));
        }
        break;
      }
      case "plugin-data.changed": {
        const pluginId = event.payload?.pluginId as string;
        const changes = event.payload?.changes as readonly PluginDataChange[];
        if (pluginId && changes) {
          const transitions = collectJobTransitions(pluginId, changes);
          options.dispatch({ type: "PLUGIN_DATA_CHANGED", pluginId, changes });
          applyPluginDataStoreChanges(pluginId, changes);
          for (const tr of transitions) emitJobTransitionToast(tr);
        }
        break;
      }
      case "turn.suspended": {
        const p = event.payload ?? {};
        const id = p.suspensionId as string | undefined;
        if (!id) break;
        const suspension: SuspensionRecord = {
          id,
          sessionId: (p.sessionId as string) ?? event.sessionId,
          turnId: (p.turnId as string) ?? "",
          runtimeId: (p.runtimeId as string) ?? "",
          pluginId: (p.pluginId as string) ?? "",
          suspendedAt: (p.suspendedAt as string) ?? event.timestamp,
          reason: p.reason as string | undefined,
          resumeSchema: p.resumeSchema,
        };
        options.dispatch({ type: "ADD_SUSPENSION", suspension });
        break;
      }
      case "turn.resumed": {
        const payload = event.payload ?? {};
        const id = payload.suspensionId as string | undefined;
        if (!id) break;
        const resumedStep = buildResumedExecutionStep(
          payload,
          typeof payload.turnId === "string" ? payload.turnId : undefined,
        );
        if (resumedStep) {
          options.dispatch({
            type: "UPSERT_EXECUTION_STEP",
            step: resumedStep,
          });
        }
        options.dispatch({ type: "REMOVE_SUSPENSION", suspensionId: id });
        break;
      }
      default:
        break;
    }
  };
}

/**
 * Re-sync state that may have drifted while the SSE stream was down. Reuses
 * the existing store actions (no new API surface): reload the session-scoped
 * plugin list and the game-state snapshot so the right-panel / character /
 * job state catch up on events missed during the reconnect window.
 */
function refreshAfterReconnect(
  sessionId: string,
  dispatch: (action: SessionAction) => void,
): void {
  api
    .listSessionPlugins(sessionId)
    .then((res) =>
      dispatch({ type: "LOAD_SESSION_PLUGINS", plugins: res.available }),
    )
    .catch(ignoreError("reload session plugins after reconnect"));
  api
    .getSessionSnapshot(sessionId)
    .then((snapshot) => {
      dispatch({
        type: "SET_GAME_STATE",
        state: enrichGameStateFromSnapshot(snapshot),
      });
    })
    .catch(ignoreError("refresh session snapshot after reconnect"));
}

export function useSessionSubscription({
  sessionId,
  dispatch,
  sessionIdRef,
}: UseSessionSubscriptionOptions): void {
  const subscriptionRef = useRef<SessionSubscription | null>(null);

  useEffect(() => {
    if (!sessionId) {
      if (subscriptionRef.current) {
        subscriptionRef.current.close();
        subscriptionRef.current = null;
      }
      setConnectionState("closed");
      return;
    }

    if (subscriptionRef.current) {
      subscriptionRef.current.close();
    }

    // Track connection lifecycle so the UI can surface reconnecting state and
    // we can backfill missed events once the stream recovers. `hasConnected`
    // distinguishes the first connect from a true reconnect (connected after
    // an interruption), so we only refresh after a genuine recovery.
    let hasConnected = false;

    const handleConnectionStateChange = (next: ConnectionState): void => {
      setConnectionState(next);
      if (next === "connected") {
        const reconnected = hasConnected;
        hasConnected = true;
        if (reconnected && sessionIdRef.current === sessionId) {
          refreshAfterReconnect(sessionId, dispatch);
        }
      }
    };

    // plugin-data.changed arrives on topic="plugin" with
    // _subType="plugin-data.changed". `game` carries F4 turn.suspended/resumed.
    const sub = createSessionSubscription(sessionId, {
      topics: ["plugin", "system", "game"],
      onStateChange: handleConnectionStateChange,
    });
    subscriptionRef.current = sub;

    const handleSubscriptionEvent = createSubscriptionEventHandler({
      dispatch,
      sessionIdRef,
    });
    sub.on("*", handleSubscriptionEvent);

    return () => {
      sub.close();
      subscriptionRef.current = null;
      setConnectionState("closed");
    };
  }, [sessionId, dispatch, sessionIdRef]);
}
