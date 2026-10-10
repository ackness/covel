import type { MutableRef } from "./runtime-refs.js";
import { pluginDataNamespaces } from "./plugin-data-records.js";
import { applyUiSlotEvent, recoverUiSlots } from "@/stores/ui-slot-store.js";
import { useEffect, useRef } from "react";
import * as api from "@/services/api";
import { primeWorldRecord } from "@/services/world-records.js";
import type { SessionWorkspace, StorageMode } from "@/services/data-service.js";
import { ignoreError } from "@/lib/ignore-error.js";
import {
  createSessionSubscription,
  type ConnectionState,
  type SessionSubscription,
  type SubscriptionEvent,
} from "@/services/subscription.js";
import {
  setConnectionState,
  registerConnectionRetry,
} from "@/stores/connection-store.js";
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
import {
  RecoveredMessageWindowError,
  publishRecoveredMessages,
  readRecoveredSnapshot,
} from "./recovered-snapshot.js";
import type { DeltaBufferRef, DeltaRafRef } from "./sse-handler.js";
import { addBlockMessageFromSse } from "./sse-handler.js";
import { reconcileExecutionSteps } from "./snapshot-execution-steps.js";
import {
  enrichGameStateFromSnapshot,
  publishSessionGameState,
} from "./game-state.js";
import {
  buildDeferredExecutionStep,
  buildJobStatusExecutionStep,
  runtimeJobCorrelationId,
} from "./execution-steps.js";
import type { SessionAction, SessionState } from "./types.js";

interface UseSessionSubscriptionOptions {
  sessionId: string | null | undefined;
  dispatch: (action: SessionAction) => void;
  workspace: SessionWorkspace;
  storageMode: StorageMode;
  sessionIdRef: MutableRef<string | null>;
  sessionGenerationRef: MutableRef<number>;
  stateRef: MutableRef<SessionState>;
  activeTurnIdRef: MutableRef<string | null>;
  deltaBufferRef: DeltaBufferRef;
  deltaRafRef: DeltaRafRef;
}

/**
 * `full` re-reads every session-side slice: events may have been lost. `state`
 * re-reads only the session snapshot: the committed change is known, and the
 * other slices follow their own events.
 */
export type RecoveryScope = "full" | "state";

// A recovery that cannot finish must not hold live events without limit.
const MAX_BUFFERED_EVENTS = 500;
const RECOVERY_RETRY_BASE_MS = 3000;
const RECOVERY_RETRY_MAX_MS = 30_000;
const RECOVERY_RETRY_LIMIT = 5;

interface ExecutionObservation {
  onSnapshotApplied?: () => void;
  stateRef: MutableRef<SessionState>;
  activeTurnIdRef: MutableRef<string | null>;
  deltaBufferRef: DeltaBufferRef;
  deltaRafRef: DeltaRafRef;
}

function executionOwner(observation: ExecutionObservation): string {
  const state = observation.stateRef.current;
  const ownsStream = state.executing && !state.executionRecovery;
  return `${ownsStream}|${state.actionGeneration ?? 0}|${observation.activeTurnIdRef.current ?? ""}`;
}

/**
 * Every durable runtime job reports its lifecycle as `job-status.updated`;
 * its `_runtime_jobs` row changes are the same transitions, so only the status
 * event marks a terminal background result.
 */
/** A detached runtime's result is committed outside every action stream. */
function endsBackgroundJob(event: SubscriptionEvent): boolean {
  if (event.type !== "job-status.updated") return false;
  const step = buildJobStatusExecutionStep(event.payload ?? {}, undefined);
  return !!step && ["completed", "failed", "skipped"].includes(step.status);
}

function isTerminalBackgroundEvent(event: SubscriptionEvent): boolean {
  if (event.type !== "job-status.updated") return false;
  const payload = event.payload ?? {};
  // Plugin progress may finish before its durable parent's domain commit.
  // Only the worker's parent control event proves the result is committed.
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const control = data as Record<string, unknown>;
  return (
    [
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
      "stale",
      "orphaned",
    ].includes(String(control.durableStatus)) &&
    ["succeeded", "failed", "cancelled"].includes(String(payload.state))
  );
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
    "dispatch" | "sessionIdRef" | "stateRef"
  > & {
    onReset: () => void;
    onBackgroundJobEnded: () => void;
    isCurrent: () => boolean;
    getRecoveryGeneration: () => number;
  },
) {
  return (event: SubscriptionEvent): void => {
    if (!options.isCurrent()) return;
    if (applyUiSlotEvent(event.sessionId, event.type, event.payload)) return;
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
        // already cleared the cursor; re-hydrate every session-side slice,
        // reusing the same recovery path as a reconnect.
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
            apply: (world) => {
              primeWorldRecord(world);
              options.dispatch({ type: "UPDATE_WORLD", world });
            },
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
          // Detached calls finish outside the action stream. Their traces and
          // messages come from the snapshot; their data has its own events.
          if (endsBackgroundJob(event)) options.onBackgroundJobEnded();
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
 * Re-sync the session-side slices represented by subscription events: all of
 * them for a `full` recovery, the session snapshot alone for a `state` one.
 * Each async result checks both the target session and recovery generation
 * before dispatching, while the hook buffers live events and replays them
 * afterward.
 */
export async function rehydrateSessionSideState(
  sessionId: string,
  sessionIdRef: MutableRef<string | null>,
  dispatch: (action: SessionAction) => void,
  isRevisionCurrent: () => boolean = () => true,
  executionObservation?: ExecutionObservation,
  scope: RecoveryScope = "full",
): Promise<void> {
  const initialExecutionOwner =
    executionObservation && executionOwner(executionObservation);
  const isCurrent = (): boolean =>
    sessionIdRef.current === sessionId && isRevisionCurrent();

  const readPluginsAndData = async (): Promise<void> => {
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
        const pluginData: PluginData = Object.create(null);
        for (const { pluginId, rows } of rowsByPlugin) {
          pluginData[pluginId] = pluginDataNamespaces(rows);
        }
        replaceSessionPluginData(sessionId, pluginData);
        dispatch({ type: "REPLACE_PLUGIN_DATA", pluginData });
      },
    });
  };

  const snapshotTask = (async () => {
    let worldId: string | undefined;
    await refreshSessionResource(
      dispatch,
      ["game-state", sessionId, "reconnect"],
      {
        isCurrent,
        read: (ownsRead) =>
          readRecoveredSnapshot(
            sessionId,
            executionObservation?.stateRef.current.messages ?? [],
            ownsRead,
          ),
        apply: (snapshot) => {
          const state = executionObservation?.stateRef.current;
          const sameOwner =
            !!executionObservation &&
            initialExecutionOwner === executionOwner(executionObservation);
          const ownsStream = !!state?.executing && !state.executionRecovery;
          const execution = snapshot.execution;
          const interruptedCurrentStream =
            execution?.state === "interrupted" &&
            !!execution.turnId &&
            execution.turnId === executionObservation?.activeTurnIdRef.current;
          if (state && executionObservation) {
            publishRecoveredMessages(
              dispatch,
              state,
              snapshot,
              execution,
              sameOwner && (!ownsStream || interruptedCurrentStream),
              executionObservation.deltaBufferRef,
              executionObservation.deltaRafRef,
            );
          } else {
            dispatch({
              type: "MERGE_RECOVERED_MESSAGES",
              messages: toStreamMessages(snapshot.messages),
            });
          }
          publishSessionGameState(
            dispatch,
            sessionId,
            enrichGameStateFromSnapshot(snapshot),
          );
          executionObservation?.onSnapshotApplied?.();
          if (
            execution &&
            executionObservation &&
            state?.session?.id === sessionId &&
            initialExecutionOwner === executionOwner(executionObservation)
          ) {
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
          worldId = snapshot.session.worldId;
        },
      },
    );
    if (scope !== "full" || !worldId || !isCurrent()) return;
    const targetWorldId = worldId;
    await refreshSessionResource(dispatch, ["world", worldId], {
      isCurrent,
      read: () => api.getWorld(targetWorldId),
      apply: (world) => {
        primeWorldRecord(world);
        dispatch({ type: "UPDATE_WORLD", world });
      },
    });
  })().catch((error: unknown) => {
    if (error instanceof RecoveredMessageWindowError) throw error;
    ignoreError("refresh session snapshot and world after reconnect")(error);
  });

  if (scope !== "full") {
    await snapshotTask;
    return;
  }

  const pluginsTask = readPluginsAndData().catch(
    ignoreError("reload session plugins and data after reconnect"),
  );
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
  storageMode,
  sessionIdRef,
  sessionGenerationRef,
  stateRef,
  activeTurnIdRef,
  deltaBufferRef,
  deltaRafRef,
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
    let stateRefreshPending = false;
    let bufferedEvents: SubscriptionEvent[] = [];
    let hasConnected = false;
    let historyRetry: ReturnType<typeof setTimeout> | undefined;
    let historyRetries = 0;
    let historyError: string | undefined;
    let replaying = false;
    // A reconnect starts recovery as soon as the stream opens. After a server
    // restart the stream then opens with a stale-cursor `system.reset`, which
    // asks for that same recovery; it is skipped while only control frames
    // have arrived on the new stream.
    let reconnectRecoveryOpen = false;

    let startRecovery: (scope: RecoveryScope, retry?: boolean) => void = () =>
      undefined;
    // A committed change is known: one snapshot read covers every notice that
    // arrives before it is published, and one more covers the ones after.
    const requestStateRefresh = (): void => {
      invalidateSessionResource(dispatch, ["game-state", sessionId]);
      if (recovering) stateRefreshPending = true;
      else startRecovery("state");
    };
    const applySubscriptionEvent = createSubscriptionEventHandler({
      dispatch,
      sessionIdRef,
      stateRef,
      onReset: () => startRecovery("full"),
      // A buffered job end asked for its refresh when it arrived.
      onBackgroundJobEnded: () => {
        if (!replaying) requestStateRefresh();
      },
      isCurrent,
      getRecoveryGeneration: () => recoveryGeneration,
    });
    const finishRecovery = (): void => {
      recovering = false;
      const replay = bufferedEvents;
      bufferedEvents = [];
      replaying = true;
      try {
        for (const event of replay) applySubscriptionEvent(event);
      } finally {
        replaying = false;
      }
    };

    startRecovery = (scope, retry = false): void => {
      if (!isCurrent()) return;
      clearTimeout(historyRetry);
      if (!retry) historyRetries = 0;
      const generation = ++recoveryGeneration;
      recovering = true;
      stateRefreshPending = false;
      // A full recovery reads again whatever the buffered events describe. A
      // state refresh reads the snapshot alone, so they still apply after it.
      if (scope === "full") bufferedEvents = [];
      let snapshotPublished = false;
      const observation = {
        stateRef,
        activeTurnIdRef,
        deltaBufferRef,
        deltaRafRef,
        onSnapshotApplied: () => {
          snapshotPublished = true;
          stateRefreshPending = false;
        },
      };
      const owner = executionOwner(observation);
      void rehydrateSessionSideState(
        sessionId,
        sessionIdRef,
        dispatch,
        () => isCurrent() && generation === recoveryGeneration,
        observation,
        scope,
      )
        .then(() => {
          if (generation !== recoveryGeneration || !isCurrent()) {
            return;
          }
          // If a POST started/ended or moved to its opening continuation during
          // the read, obtain a fresh snapshot before transferring ownership.
          if (
            owner !== executionOwner(observation) ||
            (snapshotPublished && stateRefreshPending)
          ) {
            startRecovery("state");
            return;
          }
          historyRetries = 0;
          if (historyError && stateRef.current.executionError === historyError)
            dispatch({ type: "SET_EXECUTION_ERROR", error: null });
          historyError = undefined;
          finishRecovery();
        })
        .catch((error: unknown) => {
          if (generation !== recoveryGeneration || !isCurrent()) return;
          if (owner === executionOwner(observation)) {
            historyError =
              error instanceof Error ? error.message : String(error);
            dispatch({ type: "SET_EXECUTION_ERROR", error: historyError });
          }
          ignoreError("recover session state")(error);
          // Keep the old continuous window; retry the read, never the action.
          if (historyRetries >= RECOVERY_RETRY_LIMIT) {
            // Stop asking a server that keeps failing. Live events apply to
            // the old window, and the next commit or reconnect reads again.
            finishRecovery();
            return;
          }
          const delay = Math.min(
            RECOVERY_RETRY_BASE_MS * 2 ** historyRetries,
            RECOVERY_RETRY_MAX_MS,
          );
          historyRetries += 1;
          historyRetry = setTimeout(() => startRecovery(scope, true), delay);
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
      if (reconnectRecoveryOpen && event.type !== "system.connected") {
        reconnectRecoveryOpen = false;
        if (event.type === "system.reset") return;
      }
      if (isTerminalBackgroundEvent(event)) {
        // Recovery can replace buffered projections. Checkpoint the committed
        // background result on receipt, independently of projection replay.
        const actionId = event.id
          ? `background:${event.id}`
          : `background:${crypto.randomUUID()}`;
        workspace
          .checkpoint(event.sessionId, actionId)
          .catch(ignoreError("checkpoint terminal background job"));
      }
      if (
        event.type === "state.changed" ||
        event.type === "character.upserted" ||
        event.type === "character-schema.changed" ||
        event.type === "dimensions.changed" ||
        event.type === "dimensions.settlement.changed"
      ) {
        // These are committed state notifications. Reuse the in-flight snapshot
        // read instead of buffering reset triggers or duplicating action-stream
        // patch history. A notice after publication needs one follow-up read.
        requestStateRefresh();
      } else if (event.type === "system.reset") {
        void recoverUiSlots(sessionId).catch(
          ignoreError("refresh UI slots after reset"),
        );
        startRecovery("full");
      } else if (recovering) {
        if (bufferedEvents.length >= MAX_BUFFERED_EVENTS) {
          // Reading everything again replaces the events that are dropped here.
          startRecovery("full");
          return;
        }
        // Apply live changes after the authoritative snapshot so an older HTTP
        // response cannot overwrite events delivered during recovery.
        bufferedEvents.push(event);
        // The snapshot in flight may predate this job's commit.
        if (endsBackgroundJob(event)) requestStateRefresh();
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
      reconnectRecoveryOpen = false;
      if (next === "connected") {
        const reconnected = hasConnected;
        hasConnected = true;
        if (reconnected && sessionIdRef.current === sessionId) {
          void recoverUiSlots(sessionId).catch(
            ignoreError("refresh UI slots after reconnect"),
          );
          startRecovery("full");
          reconnectRecoveryOpen = true;
        }
      }
    };

    // plugin-data.changed arrives on topic="plugin" with
    // _subType="plugin-data.changed". `game` carries turn.suspended/resumed.
    const sub = createSessionSubscription(sessionId, {
      topics: ["plugin", "system", "game", "runtime", "job", "state"],
      onStateChange: handleConnectionStateChange,
      recoverMissingSession:
        storageMode === "local"
          ? async () => {
              if (isCurrent())
                await workspace.hydrate(sessionId, { isCurrent });
            }
          : undefined,
    });
    subscriptionRef.current = sub;
    const unregisterRetry = registerConnectionRetry(() => sub.reconnect());

    sub.on("*", handleSubscriptionEvent);

    return () => {
      closed = true;
      clearTimeout(historyRetry);
      unregisterRetry();
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
    storageMode,
    sessionIdRef,
    stateRef,
    activeTurnIdRef,
    deltaBufferRef,
    deltaRafRef,
  ]);
}
