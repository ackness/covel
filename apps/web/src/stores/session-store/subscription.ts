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
  reducePluginDataChanged,
  reduceTurnResumed,
  reduceTurnSuspended,
} from "./event-reducers.js";
import { enrichGameStateFromSnapshot } from "./game-state.js";
import type { SessionAction } from "./types.js";

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
      case "system.reset": {
        // The server detected a replay gap or epoch change (ring wrapped,
        // session evicted, or pod/process restart) — our event cursor is
        // stale and we may have silently missed events. subscription.ts has
        // already cleared the cursor; re-hydrate the drift-prone authoritative
        // state (session plugins + game-state snapshot), reusing the same
        // recovery path as a reconnect. See re-review H-05/H-06.
        const sid = options.sessionIdRef.current;
        if (sid) {
          refreshAfterReconnect(sid, options.dispatch);
        }
        break;
      }
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
        reducePluginDataChanged(options.dispatch, event.payload ?? {});
        break;
      }
      case "turn.suspended": {
        reduceTurnSuspended(options.dispatch, event.payload ?? {}, {
          sessionId: event.sessionId,
          timestamp: event.timestamp,
        });
        break;
      }
      case "turn.resumed": {
        reduceTurnResumed(options.dispatch, event.payload ?? {}, {
          sessionId: event.sessionId,
          timestamp: event.timestamp,
        });
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
