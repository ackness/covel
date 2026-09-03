import * as api from "@/services/api";
import type { DataService, SessionWorkspace } from "@/services/data-service.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { setActiveSession as setActivePluginDataSession } from "@/stores/plugin-data-store.js";
import { clearAllStreamingText } from "@/stores/streaming-text-store.js";
import type { SnapshotMessage, SnapshotTraceEvent } from "@covel/shared";
import { enrichGameStateFromSnapshot } from "./game-state.js";
import type { ExecutionStep, SessionDispatch, StreamMessage } from "./types.js";

interface MutableRef<T> {
  current: T;
}

interface RestoreSessionOptions {
  ds: DataService;
  workspace: SessionWorkspace;
  dispatch: SessionDispatch;
  sessionIdRef: MutableRef<string | null>;
  worlds: readonly api.WorldRecord[];
  session: api.SessionRecord;
}

export function toStreamMessages(
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

    const runtimeTurnId =
      event.type === "runtime.deferred" &&
      typeof payload.sourceTurnId === "string"
        ? payload.sourceTurnId
        : event.turnId;
    const key = `${runtimeTurnId ?? "__no_turn__"}|${runtimeId}`;
    const prev = byKey.get(key);
    const status: ExecutionStep["status"] =
      event.type === "runtime.completed"
        ? "completed"
        : event.type === "runtime.deferred"
          ? "deferred"
          : event.type === "runtime.failed"
            ? "failed"
            : event.type === "runtime.skipped"
              ? "skipped"
              : "running";
    byKey.set(key, {
      runtimeId,
      pluginId: (payload.pluginId as string) ?? prev?.pluginId ?? "",
      status,
      turnId: runtimeTurnId,
      label: (payload.label as string | undefined) ?? prev?.label,
      durationMs:
        (payload.durationMs as number | undefined) ?? prev?.durationMs,
      startedAt:
        event.type === "runtime.started" ? event.timestamp : prev?.startedAt,
      ...(event.type === "runtime.deferred"
        ? {
            detached: true,
            jobState: "queued",
            jobId: payload.jobId as string | undefined,
          }
        : {}),
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
    // snapshot.messages 只是最近一窗；记录游标作为"加载更旧"的起点。
    // null / undefined ⇒ 已到历史开头，禁用向上加载。
    dispatch({
      type: "SET_OLDER_MESSAGES_CURSOR",
      cursor: snapshot.messagesCursor ?? null,
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
  const [messagesResult, patchesResult] = await Promise.allSettled([
    ds.listMessages(sessionId),
    ds.listStatePatches(sessionId),
  ]);

  if (messagesResult.status === "fulfilled") {
    dispatch({
      type: "LOAD_MESSAGES",
      messages: toStreamMessages(messagesResult.value),
    });
    // 本地回退走 ds.listMessages 全量恢复，没有更旧要加载 → 游标置空。
    dispatch({ type: "SET_OLDER_MESSAGES_CURSOR", cursor: null });
  }
  if (patchesResult.status === "fulfilled") {
    dispatch({
      type: "LOAD_STATE_PATCHES",
      patches: patchesResult.value,
    });
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

function toExecutionStep(raw: Record<string, unknown>): ExecutionStep {
  return {
    runtimeId: (raw.runtimeId as string) ?? "unknown",
    pluginId: (raw.pluginId as string) ?? "",
    status: raw.status as ExecutionStep["status"],
    label: raw.label as string | undefined,
    detail: raw.detail as string | undefined,
    durationMs: raw.durationMs as number | undefined,
    turnId: raw.turnId as string | undefined,
    startedAt: raw.startedAt as string | undefined,
    jobId: raw.jobId as string | undefined,
    detached: raw.detached === true,
    jobState: raw.jobState as string | undefined,
    progress: raw.progress as number | undefined,
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
    for (const step of raw.map(toExecutionStep)) {
      dispatch({ type: "UPSERT_EXECUTION_STEP", step });
    }
  } catch {
    // Execution-step persistence is best-effort browser state.
  }
}

function refreshSessionSideData(
  sessionId: string,
  targetSessionId: string,
  sessionIdRef: MutableRef<string | null>,
  dispatch: SessionDispatch,
): void {
  api
    .listSessionPlugins(sessionId)
    .then((res) => {
      if (sessionIdRef.current === targetSessionId) {
        dispatch({
          type: "LOAD_SESSION_PLUGINS",
          plugins: res.available,
          commands: res.commands,
        });
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
}

export async function restoreSessionState({
  ds,
  workspace,
  dispatch,
  sessionIdRef,
  worlds,
  session,
}: RestoreSessionOptions): Promise<void> {
  clearAllStreamingText();
  dispatch({ type: "RESET_SESSION" });
  setActivePluginDataSession(null);

  const world = worlds.find((candidate) => candidate.id === session.worldId);
  if (world) {
    dispatch({ type: "SET_WORLD", world });
  }

  const targetSessionId = session.id;
  sessionIdRef.current = targetSessionId;

  // Browser-private sessions only become executable after their durable
  // checkpoint has rebuilt the ephemeral server workspace. Publishing the
  // session first starts snapshot/plugin/SSE effects against an empty
  // MemoryStore after every server restart, producing a burst of expected
  // 404s and a transient broken UI. Remote mode implements this as a no-op.
  try {
    await workspace.hydrate(targetSessionId);
  } catch (error) {
    if (sessionIdRef.current === targetSessionId) {
      sessionIdRef.current = null;
      setActivePluginDataSession(null);
      dispatch({
        type: "SET_EXECUTION_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  if (sessionIdRef.current !== targetSessionId) return;

  api.markServerAck();
  setActivePluginDataSession(targetSessionId);
  dispatch({ type: "SET_SESSION", session });

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

  refreshSessionSideData(session.id, targetSessionId, sessionIdRef, dispatch);
}
