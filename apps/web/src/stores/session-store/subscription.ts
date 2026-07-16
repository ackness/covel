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
  replaceSessionPluginData,
  type PluginData,
} from "@/stores/plugin-data-store.js";
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
  options: Pick<UseSessionSubscriptionOptions, "dispatch" | "sessionIdRef"> & {
    onReset: () => void;
  },
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
        options.onReset();
        break;
      }
      case "plugin.activated":
      case "plugin.deactivated": {
        const currentSid = options.sessionIdRef.current;
        if (currentSid) {
          api
            .listSessionPlugins(currentSid)
            .then((res) => {
              if (options.sessionIdRef.current !== currentSid) return;
              options.dispatch({
                type: "LOAD_SESSION_PLUGINS",
                plugins: res.available,
              });
            })
            .catch(ignoreError("reload session plugins on plugin toggle"));
        }
        break;
      }
      case "world.dimensions.changed": {
        const worldId = event.payload?.worldId as string | undefined;
        const currentSid = options.sessionIdRef.current;
        if (worldId) {
          api
            .getWorld(worldId)
            .then((world) => {
              if (options.sessionIdRef.current !== currentSid) return;
              options.dispatch({ type: "UPDATE_WORLD", world });
            })
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
 * Re-sync every session-side slice represented by subscription events. Each
 * async result checks both the target session and recovery generation before
 * dispatching, while the hook buffers live events and replays them afterward.
 */
export async function rehydrateSessionSideState(
  sessionId: string,
  sessionIdRef: MutableRef<string | null>,
  dispatch: (action: SessionAction) => void,
  isRevisionCurrent: () => boolean = () => true,
): Promise<void> {
  const isCurrent = (): boolean =>
    sessionIdRef.current === sessionId && isRevisionCurrent();

  const pluginsTask = api
    .listSessionPlugins(sessionId)
    .then(async (res) => {
      if (!isCurrent()) return;
      dispatch({ type: "LOAD_SESSION_PLUGINS", plugins: res.available });
      const rowsByPlugin = await Promise.all(
        res.active.map(async (pluginId) => ({
          pluginId,
          rows: await api.listPluginData(sessionId, pluginId),
        })),
      );
      if (!isCurrent()) return;

      const pluginData: PluginData = {};
      for (const { pluginId, rows } of rowsByPlugin) {
        const namespaces: Record<string, Record<string, unknown>> = {};
        for (const row of rows) {
          (namespaces[row.namespace] ??= {})[row.key] = row.value;
        }
        pluginData[pluginId] = namespaces;
      }
      replaceSessionPluginData(sessionId, pluginData);
      dispatch({ type: "REPLACE_PLUGIN_DATA", pluginData });
    })
    .catch(ignoreError("reload session plugins and data after reconnect"));

  const snapshotTask = api
    .getSessionSnapshot(sessionId)
    .then(async (snapshot) => {
      if (!isCurrent()) return;
      dispatch({
        type: "SET_GAME_STATE",
        state: enrichGameStateFromSnapshot(snapshot),
      });
      const worldId = snapshot.session.worldId;
      if (!worldId) return;
      const world = await api.getWorld(worldId);
      if (isCurrent()) dispatch({ type: "UPDATE_WORLD", world });
    })
    .catch(ignoreError("refresh session snapshot and world after reconnect"));

  const suspensionsTask = api
    .listSuspensions(sessionId)
    .then((suspensions) => {
      if (isCurrent()) dispatch({ type: "SET_SUSPENSIONS", suspensions });
    })
    .catch(ignoreError("refresh suspensions after reconnect"));

  await Promise.all([pluginsTask, snapshotTask, suspensionsTask]);
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

    let recoveryGeneration = 0;
    let recovering = false;
    let bufferedEvents: SubscriptionEvent[] = [];
    let hasConnected = false;

    let startRecovery: () => void = () => undefined;
    const applySubscriptionEvent = createSubscriptionEventHandler({
      dispatch,
      sessionIdRef,
      onReset: () => startRecovery(),
    });

    startRecovery = (): void => {
      const generation = ++recoveryGeneration;
      recovering = true;
      bufferedEvents = [];
      void rehydrateSessionSideState(
        sessionId,
        sessionIdRef,
        dispatch,
        () => generation === recoveryGeneration,
      ).then(() => {
        if (
          generation !== recoveryGeneration ||
          sessionIdRef.current !== sessionId
        ) {
          return;
        }
        recovering = false;
        const replay = bufferedEvents;
        bufferedEvents = [];
        for (const event of replay) applySubscriptionEvent(event);
      });
    };

    const handleSubscriptionEvent = (event: SubscriptionEvent): void => {
      if (event.type === "system.reset") {
        startRecovery();
      } else if (recovering) {
        // Apply live changes after the authoritative snapshot so an older HTTP
        // response cannot overwrite events delivered during recovery.
        bufferedEvents.push(event);
      } else {
        applySubscriptionEvent(event);
      }
    };

    const handleConnectionStateChange = (next: ConnectionState): void => {
      setConnectionState(next);
      if (next === "connected") {
        const reconnected = hasConnected;
        hasConnected = true;
        if (reconnected && sessionIdRef.current === sessionId) {
          startRecovery();
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

    sub.on("*", handleSubscriptionEvent);

    return () => {
      sub.close();
      recoveryGeneration += 1;
      bufferedEvents = [];
      subscriptionRef.current = null;
      setConnectionState("closed");
    };
  }, [sessionId, dispatch, sessionIdRef]);
}
