/**
 * Plugin data store — manages pluginData state and SSE subscription.
 *
 * pluginData structure: { [pluginId]: { [namespace]: { [key]: value } } }
 *
 * Updated via:
 * 1. Initial load from /api/sessions/:id/plugin-data/:pluginId
 * 2. Real-time SSE events (plugin-data.changed)
 */

import { useSyncExternalStore, useCallback } from "react";

type PluginData = Record<string, Record<string, Record<string, unknown>>>;

type Listener = () => void;

interface PluginDataChange {
  namespace: string;
  key: string;
  value: unknown;
  operation: "set" | "delete";
}

let data: PluginData = {};
const listeners = new Set<Listener>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): PluginData {
  return data;
}

/** Apply a batch of changes from a plugin-data.changed event. */
export function applyChanges(pluginId: string, changes: readonly PluginDataChange[]): void {
  const prev = data;
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

  data = { ...prev, [pluginId]: pluginNs };
  notify();
}

/** Bulk load plugin data (e.g., from API on session restore). */
export function loadPluginData(
  pluginId: string,
  namespace: string,
  items: readonly { key: string; value: unknown }[],
): void {
  const prev = data;
  const pluginNs = { ...prev[pluginId] };
  const ns: Record<string, unknown> = {};
  for (const item of items) {
    ns[item.key] = item.value;
  }
  pluginNs[namespace] = ns;
  data = { ...prev, [pluginId]: pluginNs };
  notify();
}

/** Reset all plugin data (e.g., on session change). */
export function resetPluginData(): void {
  data = {};
  notify();
}

/** React hook — returns all plugin data. */
export function usePluginData(): PluginData {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** React hook — returns data for a specific plugin + namespace. */
export function usePluginNamespace(
  pluginId: string,
  namespace: string,
): Record<string, unknown> {
  const all = useSyncExternalStore(subscribe, getSnapshot);
  return all[pluginId]?.[namespace] ?? {};
}
