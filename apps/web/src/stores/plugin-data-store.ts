/**
 * Plugin data store — manages pluginData state and SSE subscription.
 *
 * pluginData structure: { [pluginId]: { [namespace]: { [key]: value } } }
 *
 * Scoped by sessionId so switching sessions auto-isolates state. Callers
 * must invoke `setActiveSession(sessionId | null)` as the active session
 * changes — on restoreSession, resumeSessionById, createSession, and null
 * on backToWorldSelect. Without this the module-level map would leak
 * plugin-data keys from one session into the next.
 *
 * Updated via:
 * 1. Initial load from /api/sessions/:id/plugin-data/:pluginId
 * 2. Real-time SSE events (plugin-data.changed)
 *
 * Standalone external store using useSyncExternalStore.
 */

import { useMemo, useSyncExternalStore } from "react";

export type PluginData = Record<
  string,
  Record<string, Record<string, unknown>>
>;

type Listener = () => void;

export interface PluginDataChange {
  namespace: string;
  key: string;
  value: unknown;
  operation: "set" | "delete";
}

const EMPTY_DATA: PluginData = Object.freeze({}) as PluginData;
const EMPTY_PLUGIN: Record<string, Record<string, unknown>> = Object.freeze({});
const EMPTY_NAMESPACE: Record<string, unknown> = Object.freeze({});

let activeSessionId: string | null = null;
const sessionStores = new Map<string, PluginData>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getActiveData(): PluginData {
  if (!activeSessionId) return EMPTY_DATA;
  return sessionStores.get(activeSessionId) ?? EMPTY_DATA;
}

function getSnapshot(): PluginData {
  return getActiveData();
}

/**
 * Bind the store to a specific session. Subsequent reads/writes affect
 * that session's slot; callers still read via the usual hooks. Pass
 * `null` to detach (e.g. when returning to world-select).
 */
export function setActiveSession(sessionId: string | null): void {
  if (activeSessionId === sessionId) return;
  activeSessionId = sessionId;
  if (sessionId && !sessionStores.has(sessionId)) {
    sessionStores.set(sessionId, {});
  }
  notify();
}

/** Forget one deleted session without disturbing another active session. */
export function dropPluginDataSession(sessionId: string): void {
  sessionStores.delete(sessionId);
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    notify();
  }
}

/** Test helper — wipes every slot. Not used in production paths. */
export function __clearAllPluginDataForTest(): void {
  activeSessionId = null;
  sessionStores.clear();
  notify();
}

export function getPluginNamespaceSnapshot(
  pluginId: string,
  namespace: string,
): Record<string, unknown> {
  const data = getPluginNamespacesSnapshot(pluginId);
  return Object.hasOwn(data, namespace) ? data[namespace]! : EMPTY_NAMESPACE;
}

/** Stable owner slice; writes by other plugins keep this reference unchanged. */
export function getPluginNamespacesSnapshot(
  pluginId: string,
): Record<string, Record<string, unknown>> {
  const data = getActiveData();
  return Object.hasOwn(data, pluginId) ? data[pluginId]! : EMPTY_PLUGIN;
}

/** Apply a batch of changes from a plugin-data.changed event. */
export function applyChanges(
  pluginId: string,
  changes: readonly PluginDataChange[],
): void {
  if (!activeSessionId) return;
  const prev = sessionStores.get(activeSessionId) ?? {};
  let pluginNs = { ...prev[pluginId] };

  for (const change of changes) {
    const ns = {
      ...pluginNs[change.namespace],
      ...(change.operation === "delete" ? {} : { [change.key]: change.value }),
    };
    if (change.operation === "delete") delete ns[change.key];
    pluginNs = { ...pluginNs, [change.namespace]: ns };
  }

  sessionStores.set(activeSessionId, { ...prev, [pluginId]: pluginNs });
  notify();
}

/** Bulk load plugin data (e.g., from API on session restore). */
export function loadPluginData(
  pluginId: string,
  namespace: string,
  items: readonly { key: string; value: unknown }[],
): void {
  if (!activeSessionId) return;
  loadPluginDataForSession(activeSessionId, pluginId, namespace, items);
}

/** Bulk-load data into one session without depending on the active UI slot. */
export function loadPluginDataForSession(
  sessionId: string,
  pluginId: string,
  namespace: string,
  items: readonly { key: string; value: unknown }[],
): void {
  const prev = sessionStores.get(sessionId) ?? {};
  const pluginNs = {
    ...prev[pluginId],
    [namespace]: Object.fromEntries(
      items.map((item) => [item.key, item.value]),
    ),
  };
  sessionStores.set(sessionId, { ...prev, [pluginId]: pluginNs });
  if (activeSessionId === sessionId) notify();
}

/** Replace one active session's plugin snapshot, including absent namespaces. */
export function replacePluginDataForSession(
  sessionId: string,
  pluginId: string,
  namespaces: PluginData[string],
): boolean {
  if (activeSessionId !== sessionId) return false;
  const previous = sessionStores.get(sessionId) ?? {};
  sessionStores.set(sessionId, { ...previous, [pluginId]: namespaces });
  notify();
  return true;
}

/** Atomically replace the active session's complete plugin-data snapshot. */
export function replaceSessionPluginData(
  sessionId: string,
  data: PluginData,
): boolean {
  if (activeSessionId !== sessionId) return false;
  sessionStores.set(sessionId, data);
  notify();
  return true;
}

/**
 * Reset all plugin data for the active session (e.g., on explicit
 * resetSession or backToWorldSelect). When called with no active
 * session bound it is a no-op.
 */
export function resetPluginData(): void {
  if (!activeSessionId) return;
  sessionStores.set(activeSessionId, {});
  notify();
}

/** React hook — returns all plugin data for the active session. */
export function usePluginData(): PluginData {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Subscribe to all namespaces of one plugin without rendering on other owners' writes. */
export function usePluginNamespaces(
  pluginId: string,
): Record<string, Record<string, unknown>> {
  return useSyncExternalStore(subscribe, () =>
    getPluginNamespacesSnapshot(pluginId),
  );
}

/**
 * React hook — returns data for a specific plugin + namespace.
 *
 * The snapshot is the per-(pluginId, namespace) slice, not the whole tree:
 * writers only rebuild the object identity of slices they touch, so a
 * `plugin-data.changed` event from another plugin/namespace returns the
 * same reference and React bails out without re-rendering this panel.
 */
export function usePluginNamespace(
  pluginId: string,
  namespace: string,
): Record<string, unknown> {
  return useSyncExternalStore(subscribe, () =>
    getPluginNamespaceSnapshot(pluginId, namespace),
  );
}

// ── Background job helpers ──────────────────────────────────────
//
// Background runtimes (plugin-rpc `execution: 'background'`, prompt-builders
// invoked with `expectsBackgroundFollower`, and background event followers)
// run as durable runtime jobs recorded under `(pluginId, '_runtime_jobs',
// jobId)`. Those rows also hold scheduler-detached stages; only manual and
// event activations are background jobs here. Panels bind them through the
// virtual `_jobs` data source in the record shape below.

export type PluginJobStatus = "pending" | "done" | "failed";

export interface PluginJobRecord {
  readonly jobId: string;
  readonly status: PluginJobStatus;
  readonly runtimeId?: string;
  readonly turnId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly message?: string;
  readonly messageKey?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly runtimeResults?: readonly {
    readonly runtimeId: string;
    readonly pluginId: string;
    readonly status: string;
    readonly durationMs: number;
    readonly error?: string;
    readonly output: unknown;
  }[];
  readonly deferredJobs?: readonly {
    readonly jobId: string;
    readonly runtimeId: string;
  }[];
  readonly abortReason?: string;
}

const PENDING_JOB_STATUSES = new Set([
  "queued",
  "claimed",
  "running",
  "committing",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The runtime's own error from its output, preferred over the generic one. */
function reportedError(
  result: Record<string, unknown> | undefined,
  runtimeId: string | undefined,
): string | undefined {
  const results = Array.isArray(result?.runtimeResults)
    ? (result.runtimeResults as unknown[])
    : [];
  for (const entry of results) {
    const item = record(entry);
    if (!item || (runtimeId && item.runtimeId !== runtimeId)) continue;
    if (typeof item.error === "string" && item.error) return item.error;
    const output = record(item.output);
    if (typeof output?.error === "string" && output.error) return output.error;
  }
  return undefined;
}

/**
 * Map one `_runtime_jobs` row to a background job record; `null` for
 * scheduler-detached stages and malformed rows.
 */
export function backgroundJobRecord(
  jobId: string,
  value: unknown,
): PluginJobRecord | null {
  const row = record(value);
  const activation = record(row?.origin)?.activation;
  if (!row || (activation !== "manual" && activation !== "event")) return null;
  const durable = typeof row.status === "string" ? row.status : "";
  if (!durable) return null;
  const status: PluginJobStatus = PENDING_JOB_STATUSES.has(durable)
    ? "pending"
    : durable === "succeeded"
      ? "done"
      : "failed";
  const runtimeId =
    typeof row.runtimeId === "string" ? row.runtimeId : undefined;
  const result = record(row.result);
  const error =
    status === "failed"
      ? (reportedError(result, runtimeId) ??
        (typeof row.error === "string" ? row.error : undefined))
      : undefined;
  return {
    jobId,
    status,
    ...(runtimeId ? { runtimeId } : {}),
    ...(typeof result?.turnId === "string" ? { turnId: result.turnId } : {}),
    ...(typeof row.enqueuedAt === "string"
      ? { startedAt: row.enqueuedAt }
      : {}),
    ...(typeof row.finishedAt === "string"
      ? { completedAt: row.finishedAt }
      : {}),
    ...(typeof result?.durationMs === "number"
      ? { durationMs: result.durationMs }
      : {}),
    ...(error ? { error } : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    ...(Array.isArray(result?.runtimeResults)
      ? {
          runtimeResults:
            result.runtimeResults as PluginJobRecord["runtimeResults"],
        }
      : {}),
    ...(Array.isArray(result?.deferredJobs)
      ? { deferredJobs: result.deferredJobs as PluginJobRecord["deferredJobs"] }
      : {}),
  };
}

/**
 * React hook — returns every background-job record for a plugin, newest
 * first. Updates automatically as the server writes `_runtime_jobs` rows.
 */
export function usePluginJobs(pluginId: string): readonly PluginJobRecord[] {
  const ns = useSyncExternalStore(subscribe, () =>
    getPluginNamespaceSnapshot(pluginId, "_runtime_jobs"),
  );
  return useMemo(() => {
    if (ns === EMPTY_NAMESPACE) return EMPTY_JOBS;
    const jobs: PluginJobRecord[] = [];
    for (const jobId of Object.keys(ns)) {
      const job = backgroundJobRecord(jobId, ns[jobId]);
      if (job) jobs.push(job);
    }
    jobs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    return jobs;
  }, [ns]);
}

const EMPTY_JOBS: readonly PluginJobRecord[] = Object.freeze([]);
