import * as api from "@/services/api";
import type { DataService, SessionWorkspace } from "@/services/data-service.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { setActiveSession as setActivePluginDataSession } from "@/stores/plugin-data-store.js";
import { clearAllStreamingText } from "@/stores/streaming-text-store.js";
import type { SnapshotMessage } from "@covel/shared";
import { reconcileExecutionSteps } from "./snapshot-execution-steps.js";
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
  sessionGenerationRef: MutableRef<number>;
  generation?: number;
  worlds: readonly api.WorldRecord[];
  session: api.SessionRecord;
}

export async function restoreSessionById({
  sessionId,
  ...options
}: Omit<RestoreSessionOptions, "session" | "generation"> & {
  sessionId: string;
}): Promise<void> {
  const generation = ++options.sessionGenerationRef.current;
  let session: api.SessionRecord | null;
  try {
    session = await options.ds.getSession(sessionId);
  } catch (error) {
    if (generation !== options.sessionGenerationRef.current) return;
    throw error;
  }
  if (generation !== options.sessionGenerationRef.current) return;
  if (!session) throw new Error("Session not found: " + sessionId);
  await restoreSessionState({ ...options, generation, session });
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

async function restoreServerSnapshot(
  sessionId: string,
  dispatch: SessionDispatch,
  localSteps: readonly ExecutionStep[],
  isCurrent: () => boolean,
): Promise<boolean> {
  try {
    const snapshot = await api.getSessionView(sessionId);
    if (!isCurrent()) return false;
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

    dispatch({
      type: "LOAD_EXECUTION_STEPS",
      steps: reconcileExecutionSteps(
        localSteps,
        snapshot.executionSteps,
        snapshot.execution,
      ),
    });
    dispatch({
      type: "SET_EXECUTION_RECOVERY",
      recovery: {
        sessionId,
        status: snapshot.execution ?? null,
        hydrating: false,
        checking: !snapshot.execution,
      },
    });

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
    sourceTurnId:
      typeof raw.sourceTurnId === "string" ? raw.sourceTurnId : undefined,
    ...(raw.sourceCommitted === true ? { sourceCommitted: true } : {}),
    ...(Array.isArray(raw.sourceFailedRuntimeIds) &&
    raw.sourceFailedRuntimeIds.every((id) => typeof id === "string")
      ? { sourceFailedRuntimeIds: raw.sourceFailedRuntimeIds as string[] }
      : {}),
    attemptStatus: ["pending", "committed", "failed", "interrupted"].includes(
      String(raw.attemptStatus),
    )
      ? (raw.attemptStatus as ExecutionStep["attemptStatus"])
      : undefined,
    turnStartedAt:
      typeof raw.turnStartedAt === "string" ? raw.turnStartedAt : undefined,
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
): Promise<ExecutionStep[]> {
  try {
    const raw = (await ds.loadExecutionSteps(sessionId)) as Array<
      Record<string, unknown>
    >;
    return raw.map(toExecutionStep);
  } catch {
    return [];
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
          plugins: [...res.items],
          commands: [...res.commands],
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
  sessionGenerationRef,
  generation = ++sessionGenerationRef.current,
  worlds,
  session,
}: RestoreSessionOptions): Promise<void> {
  if (generation !== sessionGenerationRef.current) return;
  const targetSessionId = session.id;
  const isCurrent = (): boolean =>
    generation === sessionGenerationRef.current &&
    sessionIdRef.current === targetSessionId;
  const dispatchCurrent: SessionDispatch = (action) => {
    if (isCurrent()) dispatch(action);
  };
  // Retain the recovery target while hydration is pending, without publishing
  // an executable session. A new visit invalidates all pending restore work.
  sessionIdRef.current = targetSessionId;
  clearAllStreamingText();
  dispatch({ type: "RESET_SESSION" });
  dispatch({
    type: "SET_EXECUTION_RECOVERY",
    recovery: {
      sessionId: session.id,
      status: null,
      hydrating: true,
      checking: true,
    },
  });
  setActivePluginDataSession(null);

  const world = worlds.find((candidate) => candidate.id === session.worldId);
  if (world) {
    dispatch({ type: "SET_WORLD", world });
  }

  // Browser-private sessions only become executable after their durable
  // checkpoint has rebuilt the ephemeral server workspace. Publishing the
  // session first starts snapshot/plugin/SSE effects against an empty
  // MemoryStore after every server restart, producing a burst of expected
  // 404s and a transient broken UI. Remote mode implements this as a no-op.
  try {
    await workspace.hydrate(targetSessionId);
  } catch (error) {
    if (!isCurrent()) return;
    dispatch({
      type: "SET_EXECUTION_RECOVERY",
      recovery: {
        sessionId: targetSessionId,
        status: null,
        hydrating: true,
        checking: true,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    setActivePluginDataSession(null);
    dispatch({
      type: "SET_EXECUTION_ERROR",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  if (!isCurrent()) return;

  api.markServerAck();
  sessionIdRef.current = targetSessionId;
  setActivePluginDataSession(targetSessionId);
  const freshSession = await api.getSession(session.id).catch(() => session);
  if (!isCurrent()) return;
  dispatch({ type: "SET_SESSION", session: freshSession });

  const localSteps = await restorePersistedExecutionSteps(ds, session.id);
  if (!isCurrent()) return;
  const snapshotLoaded = await restoreServerSnapshot(
    session.id,
    dispatchCurrent,
    localSteps,
    isCurrent,
  );
  if (!isCurrent()) return;

  if (!snapshotLoaded) {
    await restoreLocalFallback(ds, session.id, dispatchCurrent);
    if (!isCurrent()) return;
    dispatch({ type: "LOAD_EXECUTION_STEPS", steps: localSteps });
    dispatch({
      type: "SET_EXECUTION_RECOVERY",
      recovery: {
        sessionId: session.id,
        status: null,
        hydrating: false,
        checking: true,
      },
    });
  }

  await restoreSubmittedBlocks(ds, session.id, dispatchCurrent);
  if (!isCurrent()) return;

  refreshSessionSideData(
    session.id,
    targetSessionId,
    sessionIdRef,
    dispatchCurrent,
  );
}
