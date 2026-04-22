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

import { useSyncExternalStore } from "react";

type PluginData = Record<string, Record<string, Record<string, unknown>>>;

type Listener = () => void;

export interface PluginDataChange {
  namespace: string;
  key: string;
  value: unknown;
  operation: "set" | "delete";
}

const EMPTY_DATA: PluginData = Object.freeze({}) as PluginData;
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
  const data = getActiveData();
  return data[pluginId]?.[namespace] ?? EMPTY_NAMESPACE;
}

/** Apply a batch of changes from a plugin-data.changed event. */
export function applyChanges(
  pluginId: string,
  changes: readonly PluginDataChange[],
): void {
  if (!activeSessionId) return;
  const prev = sessionStores.get(activeSessionId) ?? {};
  const pluginNs = { ...prev[pluginId] };

  for (const change of changes) {
    const ns = { ...pluginNs[change.namespace] };
    if (change.operation === "delete") {
      delete ns[change.key];
    } else {
      ns[change.key] = change.value;
    }
    pluginNs[change.namespace] = ns;
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
  const prev = sessionStores.get(activeSessionId) ?? {};
  const pluginNs = { ...prev[pluginId] };
  const ns: Record<string, unknown> = {};
  for (const item of items) {
    ns[item.key] = item.value;
  }
  pluginNs[namespace] = ns;
  sessionStores.set(activeSessionId, { ...prev, [pluginId]: pluginNs });
  notify();
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

/** React hook — returns data for a specific plugin + namespace. */
export function usePluginNamespace(
  pluginId: string,
  namespace: string,
): Record<string, unknown> {
  const all = useSyncExternalStore(subscribe, getSnapshot);
  return all[pluginId]?.[namespace] ?? EMPTY_NAMESPACE;
}

/**
 * React hook — discovers the character-attribute schema written by whichever
 * plugin declares `capabilities: [world-data-provider]`. The schema lives
 * under the well-known path `(*, 'schema', 'character-attributes')`, so we
 * scan across all pluginIds and return the first match instead of hardcoding
 * `core-world-init` (framework/plugin isolation rule).
 *
 * Returns `null` when no world has produced a schema yet.
 */
export function useCharacterAttributeSchema(): unknown {
  const all = useSyncExternalStore(subscribe, getSnapshot);
  for (const pluginId of Object.keys(all)) {
    const value = all[pluginId]?.["schema"]?.["character-attributes"];
    if (value) return value;
  }
  return null;
}
