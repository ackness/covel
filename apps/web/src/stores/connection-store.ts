/**
 * Connection store — tracks the live SSE subscription connection state so a
 * lightweight UI indicator can reflect connecting / connected / reconnecting
 * / closed without re-rendering the whole SessionContext.
 *
 * Standalone external store using useSyncExternalStore (same pattern as
 * plugin-data-store).
 */

import { useSyncExternalStore } from "react";
import type { ConnectionState } from "@/services/subscription.js";

let connectionState: ConnectionState = "closed";
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ConnectionState {
  return connectionState;
}

export function setConnectionState(next: ConnectionState): void {
  if (connectionState === next) return;
  connectionState = next;
  notify();
}

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
