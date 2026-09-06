import type { EventBus } from "@covel/events";
import type { HookPipeline } from "@covel/runtime";
import { runSessionEndHook, runWithHookScope } from "@covel/runtime";
import type { DataStore, SessionRecord } from "@covel/store";
import { backgroundRuntimeLockId } from "../plugin-rpc/runtime-turn.js";
import {
  SESSION_DELETION_END_FIRED_KEY,
  SESSION_DELETION_PENDING_KEY,
  SESSION_DELETION_RETRY_KEY,
  SESSION_DELETION_STARTED_AT_KEY,
  SESSION_LIFECYCLE_PENDING_KEY,
} from "./session-guard.js";

const SESSION_LIFECYCLE_LEASE_MS = 10 * 60 * 1000;
export const SESSION_DELETION_LEASE_MS = 10 * 60 * 1000;

export interface SessionLifecyclePending {
  readonly opId: string;
  readonly event: "SessionStart" | "SessionEnd";
  readonly startedAt: string;
}

export async function backgroundLocksForSession(
  sessionId: string,
  store: DataStore,
): Promise<string[]> {
  const runtimeNames = new Set<string>();
  for (const row of await store.listPluginDataSessionScope(sessionId)) {
    if (row.namespace !== "_jobs" && row.namespace !== "_runtime_jobs") {
      continue;
    }
    const value = row.value as {
      readonly status?: unknown;
      readonly runtimeId?: unknown;
    };
    const active =
      row.namespace === "_jobs"
        ? value?.status === "pending"
        : value?.status === "queued" ||
          value?.status === "claimed" ||
          value?.status === "running" ||
          value?.status === "committing";
    if (active && typeof value.runtimeId === "string") {
      runtimeNames.add(value.runtimeId);
    }
  }
  return [...runtimeNames]
    .map((runtimeId) => backgroundRuntimeLockId(sessionId, runtimeId))
    .sort();
}

export function readSessionLifecyclePending(
  session: SessionRecord,
): SessionLifecyclePending | undefined {
  const raw = session.metadata?.[SESSION_LIFECYCLE_PENDING_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.opId !== "string" ||
    (value.event !== "SessionStart" && value.event !== "SessionEnd") ||
    typeof value.startedAt !== "string"
  ) {
    return undefined;
  }
  return {
    opId: value.opId,
    event: value.event,
    startedAt: value.startedAt,
  };
}

export function lifecycleLeaseIsFresh(
  pending: SessionLifecyclePending,
): boolean {
  const startedAt = Date.parse(pending.startedAt);
  return (
    Number.isFinite(startedAt) &&
    Date.now() - startedAt <= SESSION_LIFECYCLE_LEASE_MS
  );
}

export function withoutLifecyclePending(
  metadata: SessionRecord["metadata"],
): Record<string, unknown> {
  const { [SESSION_LIFECYCLE_PENDING_KEY]: _pending, ...rest } = metadata ?? {};
  return { ...rest, [SESSION_LIFECYCLE_PENDING_KEY]: undefined };
}

export function withoutDeletionControl(
  metadata: SessionRecord["metadata"],
): Record<string, unknown> {
  const {
    [SESSION_DELETION_PENDING_KEY]: _pending,
    [SESSION_DELETION_STARTED_AT_KEY]: _startedAt,
    [SESSION_DELETION_RETRY_KEY]: _retry,
    [SESSION_DELETION_END_FIRED_KEY]: _endFired,
    ...rest
  } = metadata ?? {};
  return {
    ...rest,
    [SESSION_DELETION_PENDING_KEY]: undefined,
    [SESSION_DELETION_STARTED_AT_KEY]: undefined,
    [SESSION_DELETION_RETRY_KEY]: undefined,
    [SESSION_DELETION_END_FIRED_KEY]: undefined,
  };
}

/**
 * Run the observe-only SessionEnd hook under the session's plugin scope, then
 * await the audit persistence barrier before returning. Mutation already
 * succeeded, so hook failures are logged; dropped or failed saves remain
 * best-effort because ending sessions have no later flush.
 */
export async function fireSessionEnd(
  pipeline: HookPipeline | undefined,
  eventBus: EventBus | undefined,
  sessionId: string,
  activePlugins: readonly string[],
  reason: "ended" | "deleted",
): Promise<void> {
  try {
    await runWithHookScope({ activePluginIds: new Set(activePlugins) }, () =>
      runSessionEndHook(
        { pipeline, sessionId, turnId: "", eventBus },
        { sessionId, reason },
      ),
    );
    await eventBus?.flush();
  } catch (error) {
    console.warn(
      "[sessions] SessionEnd hook failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
