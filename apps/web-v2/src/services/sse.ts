/**
 * SSE event subscription — connects to /api/events/stream and dispatches events.
 */

import { applyChanges } from "@/stores/plugin-data-store.js";

export interface SSEOptions {
  sessionId: string;
  topics?: string[];
  lastEventId?: string;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
}

export function connectSSE(options: SSEOptions): () => void {
  const params = new URLSearchParams({ sessionId: options.sessionId });
  if (options.topics) params.set("topics", options.topics.join(","));
  if (options.lastEventId) params.set("lastEventId", options.lastEventId);

  const source = new EventSource(`/api/events/stream?${params}`);

  source.addEventListener("plugin-data.changed", (e) => {
    const data = JSON.parse(e.data) as {
      payload: {
        pluginId: string;
        changes: Array<{ namespace: string; key: string; value: unknown; operation: "set" | "delete" }>;
      };
    };
    const { pluginId, changes } = data.payload;
    if (pluginId && changes) {
      applyChanges(pluginId, changes);
    }
    options.onEvent?.("plugin-data.changed", data.payload);
  });

  // phase.changed — fires when a server-side proposal or tool transitions
  // session phase. Without this listener, the frontend reducer would only
  // hear about the previously-hardcoded `phase.changed = playing` emit
  // (which Task 5 of the audit fixes correctly removed). Followup D wires
  // the real path: `create-character` tool → eventBus → /api/events/stream
  // → this listener → session-store reducer.
  source.addEventListener("phase.changed", (e) => {
    try {
      const data = JSON.parse(e.data) as { payload?: { phase?: string } };
      if (data.payload) options.onEvent?.("phase.changed", data.payload);
    } catch {
      // ignore non-JSON messages
    }
  });

  // Generic event handler for unnamed events (kept for forward-compat with
  // protocol additions; named SSE events bypass this handler).
  source.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as Record<string, unknown>;
      const type = (data.type as string) ?? "unknown";
      options.onEvent?.(type, data);
    } catch {
      // ignore non-JSON messages
    }
  };

  source.onerror = () => {
    // EventSource auto-reconnects
  };

  return () => source.close();
}
