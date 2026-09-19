import { useEffect, useRef } from "react";
import * as api from "@/services/api";
import type { SessionWorkspace } from "@/services/data-service.js";
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
import {
  invalidateSessionResource,
  refreshSessionResource,
} from "./session-resource-reads.js";
import { toStreamMessages } from "./restore-session.js";
import { addBlockMessageFromSse } from "./sse-handler.js";
import { reconcileExecutionSteps } from "./snapshot-execution-steps.js";
import { enrichGameStateFromSnapshot } from "./game-state.js";
import {
  buildDeferredExecutionStep,
  buildJobStatusExecutionStep,
  runtimeJobCorrelationId,
} from "./execution-steps.js";
import type { SessionAction, SessionState } from "./types.js";

interface MutableRef<T> {
  current: T;
}

interface UseSessionSubscriptionOptions {
  sessionId: string | null | undefined;
  dispatch: (action: SessionAction) => void;
  workspace: SessionWorkspace;
  sessionIdRef: MutableRef<string | null>;
  sessionGenerationRef: MutableRef<number>;
  stateRef: MutableRef<SessionState>;
  activeTurnIdRef: MutableRef<string | null>;
}

interface ExecutionObservation {
  stateRef: MutableRef<SessionState>;
  activeTurnIdRef: MutableRef<string | null>;
}

function executionOwner(observation: ExecutionObservation): string {
  const state = observation.stateRef.current;
  const ownsStream = state.executing && !state.executionRecovery;
  return `${ownsStream}|${state.actionGeneration ?? 0}|${observation.activeTurnIdRef.current ?? ""}`;
}

function containsTerminalBackgroundJob(
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const changes = payload.changes;
  if (!Array.isArray(changes)) return false;
  return changes.some((change) => {
    if (!change || typeof change !== "object") return false;
    const row = change as Record<string, unknown>;
    if (row.namespace !== "_jobs") return false;
    const value = row.value;
    if (!value || typeof value !== "object") return false;
    const status = (value as Record<string, unknown>).status;
    return status === "done" || status === "failed";
  });
}

export function isCurrentSubscriptionEvent(
  event: SubscriptionEvent,
  subscribedSessionId: string,
  activeSessionId: string | null,
): boolean {
  return (
    activeSessionId === subscribedSessionId &&
    event.sessionId === subscribedSessionId
  );
}

export function createSubscriptionEventHandler(
  options: Pick<
    UseSessionSubscriptionOptions,
    "dispatch" | "workspace" | "sessionIdRef" | "stateRef"
  > & {
    onReset: () => void;
    isCurrent: () => boolean;
    getRecoveryGeneration: () => number;
  },
) {
  return (event: SubscriptionEvent): void => {
    if (!options.isCurrent()) return;
    switch (event.type) {
      case "interaction.requested":
      case "ui.rendered": {
        const payload = event.payload ?? {};
        const block = payload.block;
        if (block && typeof block === "object" && !Array.isArray(block)) {
          addBlockMessageFromSse(
            options,
            block as Record<string, unknown>,
            payload,
            event.timestamp,
          );
        }
        break;
      }
      case "system.reset": {
        // The server detected a replay gap or epoch change (ring wrapped,
        // session evicted, or pod/process restart) — our event cursor is
        // stale and we may have silently missed events. subscription.ts has
        // already cleared the cursor; re-hydrate the drift-prone authoritative
        // state (session plugins + game-state snapshot), reusing the same
        // recovery path as a reconnect.
        options.onReset();
        break;
      }
      case "plugin.activated":
      case "plugin.deactivated": {
        const currentSid = options.sessionIdRef.current;
        if (currentSid) {
          const recovery = options.getRecoveryGeneration();
          invalidateSessionResource(options.dispatch, ["ui-specs", currentSid]);
          void refreshSessionResource(
            options.dispatch,
            ["plugins", currentSid],
            {
              isCurrent: () =>
                options.isCurrent() &&
                options.sessionIdRef.current === currentSid &&
                recovery === options.getRecoveryGeneration(),
              read: () => api.listSessionPlugins(currentSid),
              apply: (res) =>
                options.dispatch({
                  type: "LOAD_SESSION_PLUGINS",
                  plugins: [...res.items],
                  commands: [...res.commands],
                }),
            },
          ).catch(ignoreError("reload session plugins on plugin toggle"));
        }
        break;
      }
      case "world.dimensions.changed": {
        const worldId = event.payload?.worldId;
        const currentSid = options.sessionIdRef.current;
        if (
          typeof worldId === "string" &&
          worldId &&
          worldId === options.stateRef.current.session?.worldId
        ) {
          const recovery = options.getRecoveryGeneration();
          void refreshSessionResource(options.dispatch, ["world", worldId], {
            isCurrent: () =>
              options.isCurrent() &&
              options.sessionIdRef.current === currentSid &&
              options.stateRef.current.session?.worldId === worldId &&
              recovery === options.getRecoveryGeneration(),
            read: () => api.getWorld(worldId),
            apply: (world) => options.dispatch({ type: "UPDATE_WORLD", world }),
          }).catch(ignoreError("refresh world on dimensions changed"));
        }
        break;
      }
      case "plugin-data.changed": {
        reducePluginDataChanged(
          options.dispatch,
          event.payload ?? {},
          event.sessionId,
        );
        if (containsTerminalBackgroundJob(event.payload ?? {})) {
          options.onReset();
          const actionId = event.id
            ? `background:${event.id}`
            : `background:${crypto.randomUUID()}`;
          options.workspace
            .checkpoint(event.sessionId, actionId)
            .catch(ignoreError("checkpoint terminal background job"));
        }
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
      case "job-status.updated": {
        const payload = event.payload ?? {};
        const jobId = runtimeJobCorrelationId(payload);
        const existing = options.stateRef.current.executionSteps.find(
          (step) => jobId && step.jobId === jobId,
        );
        const step = buildJobStatusExecutionStep(payload, existing);
        if (step) {
          options.dispatch({ type: "UPSERT_EXECUTION_STEP", step });
          // Detached calls finish outside the action stream. Recover their traces.
          if (["completed", "failed", "skipped"].includes(step.status))
            options.onReset();
        }
        break;
      }
      case "runtime.deferred": {
        const step = buildDeferredExecutionStep(
          event.payload ?? {},
          undefined,
          event.timestamp,
        );
        if (step) {
          options.dispatch({ type: "UPSERT_EXECUTION_STEP", step });
        }
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
  executionObservation?: ExecutionObservation,
): Promise<void> {
  const initialExecutionOwner =
    executionObservation && executionOwner(executionObservation);
  const isCurrent = (): boolean =>
    sessionIdRef.current === sessionId && isRevisionCurrent();

  const pluginsTask = (async () => {
    const loaded: { plugins?: api.SessionPlugin[] } = {};
    await refreshSessionResource(dispatch, ["plugins", sessionId], {
      isCurrent,
      read: () => api.listSessionPlugins(sessionId),
      apply: (res) => {
        loaded.plugins = [...res.items];
        dispatch({
          type: "LOAD_SESSION_PLUGINS",
          plugins: loaded.plugins,
          commands: [...res.commands],
        });
      },
    });
    if (!loaded.plugins || !isCurrent()) return;
    const activePlugins = loaded.plugins.filter((plugin) => plugin.active);
    await refreshSessionResource(dispatch, ["plugin-data", sessionId], {
      isCurrent,
      read: () =>
        Promise.all(
          activePlugins.map(async ({ id: pluginId }) => ({
            pluginId,
            rows: await api.listPluginData(sessionId, pluginId),
          })),
        ),
      apply: (rowsByPlugin) => {
        const pluginData: PluginData = {};
        for (const { pluginId, rows } of rowsByPlugin) {
          const namespaces: Record<string, Record<string, unknown>> = {};
          for (const row of rows)
            (namespaces[row.namespace] ??= {})[row.key] = row.value;
          pluginData[pluginId] = namespaces;
        }
        replaceSessionPluginData(sessionId, pluginData);
        dispatch({ type: "REPLACE_PLUGIN_DATA", pluginData });
      },
    });
  })().catch(ignoreError("reload session plugins and data after reconnect"));

  const snapshotTask = api
    .getSessionView(sessionId)
    .then(async (snapshot) => {
      if (!isCurrent()) return;
      dispatch({
        type: "MERGE_RECOVERED_MESSAGES",
        messages: toStreamMessages(snapshot.messages),
      });
      dispatch({
        type: "SET_GAME_STATE",
        state: enrichGameStateFromSnapshot(snapshot),
      });
      const execution = snapshot.execution;
      const state = executionObservation?.stateRef.current;
      if (
        execution &&
        executionObservation &&
        state?.session?.id === sessionId &&
        initialExecutionOwner === executionOwner(executionObservation)
      ) {
        const ownsStream = state.executing && !state.executionRecovery;
        const interruptedCurrentStream =
          execution.state === "interrupted" &&
          !!execution.turnId &&
          execution.turnId === executionObservation.activeTurnIdRef.current;
        // A healthy POST stream remains authoritative for its live steps.
        // Only confirmed interruption of that exact turn transfers ownership;
        // disconnected/refresh sessions can adopt every server state.
        if (!ownsStream || interruptedCurrentStream) {
          dispatch({
            type: "LOAD_EXECUTION_STEPS",
            steps: reconcileExecutionSteps(
              state.executionSteps,
              snapshot.executionSteps,
              execution,
            ),
          });
          dispatch({
            type: "SET_SESSION",
            session: { ...state.session, ...snapshot.session },
          });
          dispatch({
            type: "SET_EXECUTION_RECOVERY",
            recovery: {
              sessionId,
              status: execution,
              checking: false,
              hydrating: false,
            },
          });
        }
      }
      const worldId = snapshot.session.worldId;
      if (!worldId) return;
      await refreshSessionResource(dispatch, ["world", worldId], {
        isCurrent,
        read: () => api.getWorld(worldId),
        apply: (world) => dispatch({ type: "UPDATE_WORLD", world }),
      });
    })
    .catch(ignoreError("refresh session snapshot and world after reconnect"));

  const suspensionsTask = refreshSessionResource(
    dispatch,
    ["suspensions", sessionId],
    {
      isCurrent,
      read: () => api.listSuspensions(sessionId),
      apply: (suspensions) =>
        dispatch({ type: "SET_SUSPENSIONS", suspensions }),
    },
  ).catch(ignoreError("refresh suspensions after reconnect"));

  await Promise.all([pluginsTask, snapshotTask, suspensionsTask]);
}

export function useSessionSubscription({
  sessionId,
  dispatch,
  workspace,
  sessionIdRef,
  sessionGenerationRef,
  stateRef,
  activeTurnIdRef,
}: UseSessionSubscriptionOptions): void {
  const sessionGeneration = sessionGenerationRef.current;
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

    let closed = false;
    const isCurrent = (): boolean =>
      !closed &&
      sessionIdRef.current === sessionId &&
      sessionGenerationRef.current === sessionGeneration;
    let recoveryGeneration = 0;
    let recovering = false;
    let bufferedEvents: SubscriptionEvent[] = [];
    let hasConnected = false;

    let startRecovery: () => void = () => undefined;
    const applySubscriptionEvent = createSubscriptionEventHandler({
      dispatch,
      workspace,
      sessionIdRef,
      stateRef,
      onReset: () => startRecovery(),
      isCurrent,
      getRecoveryGeneration: () => recoveryGeneration,
    });

    startRecovery = (): void => {
      if (!isCurrent()) return;
      const generation = ++recoveryGeneration;
      recovering = true;
      bufferedEvents = [];
      const observation = { stateRef, activeTurnIdRef };
      const owner = executionOwner(observation);
      void rehydrateSessionSideState(
        sessionId,
        sessionIdRef,
        dispatch,
        () => isCurrent() && generation === recoveryGeneration,
        observation,
      ).then(() => {
        if (generation !== recoveryGeneration || !isCurrent()) {
          return;
        }
        // If a POST started/ended or moved to its opening continuation during
        // the read, obtain a fresh snapshot before transferring ownership.
        if (owner !== executionOwner(observation)) {
          startRecovery();
          return;
        }
        recovering = false;
        const replay = bufferedEvents;
        bufferedEvents = [];
        for (const event of replay) applySubscriptionEvent(event);
      });
    };

    const handleSubscriptionEvent = (event: SubscriptionEvent): void => {
      // React updates the subscription effect after commit. During a session
      // switch, the old stream can therefore deliver one last event after
      // restoreSession has already rebound the shared stores to the new id.
      // Reject both stale connections and malformed/cross-session envelopes.
      if (
        !isCurrent() ||
        !isCurrentSubscriptionEvent(event, sessionId, sessionIdRef.current)
      ) {
        return;
      }
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
      if (!isCurrent()) return;
      setConnectionState(next);
      // Even a tab opened in the background can miss state changes before its
      // first subscription. Recover on visibility resume as on a reconnect.
      if (next === "paused") hasConnected = true;
      if (next === "connected") {
        const reconnected = hasConnected;
        hasConnected = true;
        if (reconnected && sessionIdRef.current === sessionId) {
          startRecovery();
        }
      }
    };

    // plugin-data.changed arrives on topic="plugin" with
    // _subType="plugin-data.changed". `game` carries turn.suspended/resumed.
    const sub = createSessionSubscription(sessionId, {
      topics: ["plugin", "system", "game", "runtime", "job", "state"],
      onStateChange: handleConnectionStateChange,
    });
    subscriptionRef.current = sub;

    sub.on("*", handleSubscriptionEvent);

    return () => {
      closed = true;
      sub.close();
      recoveryGeneration += 1;
      bufferedEvents = [];
      subscriptionRef.current = null;
      setConnectionState("closed");
    };
  }, [
    sessionId,
    sessionGeneration,
    sessionGenerationRef,
    dispatch,
    workspace,
    sessionIdRef,
    stateRef,
    activeTurnIdRef,
  ]);
}
