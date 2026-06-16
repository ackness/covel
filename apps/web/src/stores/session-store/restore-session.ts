import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { setActiveSession as setActivePluginDataSession } from "@/stores/plugin-data-store.js";
import type { SnapshotMessage, SnapshotTraceEvent } from "@covel/shared";
import { enrichGameStateFromSnapshot } from "./game-state.js";
import type { ExecutionStep, SessionDispatch, StreamMessage } from "./types.js";

interface MutableRef<T> {
  current: T;
}

interface RestoreSessionOptions {
  ds: DataService;
  dispatch: SessionDispatch;
  sessionIdRef: MutableRef<string | null>;
  worlds: readonly api.WorldRecord[];
  session: api.SessionRecord;
}

function toStreamMessages(
  messages: readonly (api.MessageRecord | SnapshotMessage)[],
): StreamMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role as "system" | "user" | "assistant",
    content: message.content,
    timestamp: message.createdAt,
    turnId: message.turnId,
    runtimeId: message.runtimeId,
    kind: message.kind,
    ...(message.block
      ? { block: message.block as Record<string, unknown> }
      : {}),
  }));
}

function buildSnapshotExecutionSteps(
  events: readonly SnapshotTraceEvent[],
): ExecutionStep[] {
  const byKey = new Map<string, ExecutionStep>();
  for (const event of events) {
    if (!event.type.startsWith("runtime.")) continue;
    const payload = event.payload as Record<string, unknown>;
    const runtimeId = (payload.runtimeId as string) ?? "";
    if (!runtimeId || runtimeId === "__turn__") continue;

    const key = `${event.turnId ?? "__no_turn__"}|${runtimeId}`;
    const prev = byKey.get(key);
    const status: ExecutionStep["status"] =
      event.type === "runtime.completed"
        ? "completed"
        : event.type === "runtime.failed"
          ? "failed"
          : event.type === "runtime.skipped"
            ? "skipped"
            : "running";
    byKey.set(key, {
      runtimeId,
      pluginId: (payload.pluginId as string) ?? prev?.pluginId ?? "",
      status,
      turnId: event.turnId,
      label: (payload.label as string | undefined) ?? prev?.label,
      durationMs:
        (payload.durationMs as number | undefined) ?? prev?.durationMs,
      startedAt:
        event.type === "runtime.started" ? event.timestamp : prev?.startedAt,
    });
  }
  return [...byKey.values()];
}

async function restoreServerSnapshot(
  sessionId: string,
  dispatch: SessionDispatch,
): Promise<boolean> {
  try {
    const snapshot = await api.getSessionSnapshot(sessionId);
    dispatch({
      type: "LOAD_MESSAGES",
      messages: toStreamMessages(snapshot.messages),
    });

    if (
      snapshot.characters.length > 0 ||
      Object.keys(snapshot.gameState).length > 0 ||
      snapshot.characterSchema
    ) {
      dispatch({
        type: "SET_GAME_STATE",
        state: enrichGameStateFromSnapshot(snapshot),
      });
    }

    const steps = buildSnapshotExecutionSteps(snapshot.executionSteps);
    if (steps.length > 0) {
      dispatch({ type: "LOAD_EXECUTION_STEPS", steps });
    }

    return true;
  } catch {
    return false;
  }
}

async function restoreLocalFallback(
  ds: DataService,
  sessionId: string,
  dispatch: SessionDispatch,
): Promise<void> {
  const [messagesResult, patchesResult, stateSnapResult] =
    await Promise.allSettled([
      ds.listMessages(sessionId),
      ds.listStatePatches(sessionId),
      ds.loadStateSnapshot(sessionId),
    ]);

  if (messagesResult.status === "fulfilled") {
    dispatch({
      type: "LOAD_MESSAGES",
      messages: toStreamMessages(messagesResult.value),
    });
  }
  if (patchesResult.status === "fulfilled") {
    dispatch({
      type: "LOAD_STATE_PATCHES",
      patches: patchesResult.value,
    });
  }
  if (stateSnapResult.status === "fulfilled" && stateSnapResult.value) {
    const snapshotState = stateSnapResult.value.state as
      | Record<string, unknown>
      | undefined;
    if (snapshotState) {
      dispatch({ type: "SET_GAME_STATE", state: snapshotState });
    }
  }
}

async function restoreSubmittedBlocks(
  ds: DataService,
  sessionId: string,
  dispatch: SessionDispatch,
): Promise<void> {
  try {
    const { ids: blockIds, values: blockValues } =
      await ds.loadSubmittedBlocks(sessionId);
    for (const blockId of blockIds) {
      dispatch({
        type: "SUBMIT_BLOCK",
        blockId,
        values: blockValues[blockId],
      });
    }
  } catch {
    // Submitted block persistence is best-effort browser state.
  }
}

function migrateExecutionStep(raw: Record<string, unknown>): ExecutionStep {
  const legacyType = raw.type as string | undefined;
  const legacyStatus: ExecutionStep["status"] =
    legacyType === "runtime.completed"
      ? "completed"
      : legacyType === "runtime.failed"
        ? "failed"
        : legacyType === "runtime.skipped"
          ? "skipped"
          : ((raw.status as ExecutionStep["status"] | undefined) ??
            "completed");
  return {
    runtimeId: (raw.runtimeId as string) ?? "unknown",
    pluginId: (raw.pluginId as string) ?? "",
    status: legacyStatus,
    label: raw.label as string | undefined,
    detail: raw.detail as string | undefined,
    durationMs: raw.durationMs as number | undefined,
    turnId: raw.turnId as string | undefined,
    startedAt:
      (raw.startedAt as string | undefined) ??
      (raw.timestamp as string | undefined),
  };
}

async function restorePersistedExecutionSteps(
  ds: DataService,
  sessionId: string,
  dispatch: SessionDispatch,
): Promise<void> {
  try {
    const raw = (await ds.loadExecutionSteps(sessionId)) as Array<
      Record<string, unknown>
    >;
    for (const step of raw.map(migrateExecutionStep)) {
      dispatch({ type: "UPSERT_EXECUTION_STEP", step });
    }
  } catch {
    // Legacy sessions may have no persisted execution step cache.
  }
}

function refreshSessionSideData(
  ds: DataService,
  sessionId: string,
  targetSessionId: string,
  sessionIdRef: MutableRef<string | null>,
  dispatch: SessionDispatch,
): void {
  api
    .listSessionPlugins(sessionId)
    .then((res) => {
      if (sessionIdRef.current === targetSessionId) {
        dispatch({ type: "LOAD_SESSION_PLUGINS", plugins: res.available });
      }
    })
    .catch(ignoreError("list session plugins on restore"));

  api
    .listSuspensions(sessionId)
    .then((suspensions) => {
      if (sessionIdRef.current === targetSessionId) {
        dispatch({ type: "SET_SUSPENSIONS", suspensions });
      }
    })
    .catch(ignoreError("list suspensions on restore"));

  ds.syncToServer(sessionId)
    .then(() => {
      if (sessionIdRef.current === targetSessionId) {
        api.markServerAck();
      }
    })
    .catch((err: unknown) => {
      console.warn("[session] syncToServer failed:", err);
    });
}

export async function restoreSessionState({
  ds,
  dispatch,
  sessionIdRef,
  worlds,
  session,
}: RestoreSessionOptions): Promise<void> {
  dispatch({ type: "RESET_SESSION" });

  const world = worlds.find((candidate) => candidate.id === session.worldId);
  if (world) {
    dispatch({ type: "SET_WORLD", world });
  }
  dispatch({ type: "SET_SESSION", session });

  const targetSessionId = session.id;
  sessionIdRef.current = targetSessionId;
  setActivePluginDataSession(targetSessionId);

  const snapshotLoaded = await restoreServerSnapshot(session.id, dispatch);
  if (sessionIdRef.current !== targetSessionId) return;

  if (!snapshotLoaded) {
    await restoreLocalFallback(ds, session.id, dispatch);
    if (sessionIdRef.current !== targetSessionId) return;
  }

  await restoreSubmittedBlocks(ds, session.id, dispatch);
  if (sessionIdRef.current !== targetSessionId) return;

  await restorePersistedExecutionSteps(ds, session.id, dispatch);
  if (sessionIdRef.current !== targetSessionId) return;

  refreshSessionSideData(
    ds,
    session.id,
    targetSessionId,
    sessionIdRef,
    dispatch,
  );
}
