/**
 * Persistent SSE subscription client for real-time session events.
 *
 * Uses fetch + ReadableStream (same pattern as sendAction in api.ts)
 * to support custom headers (provider keys, slot config).
 *
 * This is separate from the /actions SSE handler which handles
 * high-frequency turn-execution events (message.delta, message.completed, block.emitted).
 * The subscription handles lifecycle events: runtime.*, state.*, game.*, plugin.*, session.*, system.*.
 */

import { parseJsonSseData, readSseStream } from "./sse.js";

// ── Types ──────────────────────────────────────────────────────────

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export interface SubscriptionEvent {
  id: string;
  topic: string;
  type: string;
  sessionId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export type SubscriptionEventHandler = (event: SubscriptionEvent) => void;
export type ConnectionStateHandler = (state: ConnectionState) => void;

export interface SessionSubscriptionOptions {
  topics?: string[];
  onStateChange?: ConnectionStateHandler;
}

export interface SessionSubscription {
  readonly state: ConnectionState;
  /** Subscribe to events of a specific topic (e.g., 'runtime', 'state'). Use '*' for all. */
  on(topic: string, handler: SubscriptionEventHandler): void;
  /** Unsubscribe a handler. */
  off(topic: string, handler: SubscriptionEventHandler): void;
  /** Close the connection and clean up. */
  close(): void;
}

// ── Constants ─────────────────────────────────────────────────────

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

// ── Implementation ────────────────────────────────────────────────

export function createSessionSubscription(
  sessionId: string,
  options?: SessionSubscriptionOptions,
): SessionSubscription {
  const topics = options?.topics ?? [
    "runtime",
    "state",
    "game",
    "plugin",
    "session",
    "system",
  ];
  const onStateChange = options?.onStateChange;

  let connectionState: ConnectionState = "connecting";
  let abortController: AbortController | null = null;
  let lastEventId = "";
  let backoffMs = INITIAL_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  // Topic -> Set<handler>
  const handlers = new Map<string, Set<SubscriptionEventHandler>>();

  function setState(next: ConnectionState): void {
    if (connectionState === next) return;
    connectionState = next;
    onStateChange?.(next);
  }

  function dispatch(event: SubscriptionEvent): void {
    // Route to topic-specific handlers
    const topicHandlers = handlers.get(event.topic);
    if (topicHandlers) {
      for (const handler of topicHandlers) {
        try {
          handler(event);
        } catch {
          // Don't let a handler error kill the subscription
        }
      }
    }
    // Route to wildcard handlers
    const wildcardHandlers = handlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(event);
        } catch {
          // Don't let a handler error kill the subscription
        }
      }
    }
  }

  function buildUrl(): string {
    const params = new URLSearchParams({
      sessionId,
      topics: topics.join(","),
    });
    if (lastEventId) {
      params.set("lastEventId", lastEventId);
    }
    return `/api/events/stream?${params.toString()}`;
  }

  /**
   * Extract the topic from an SSE event type string.
   * E.g. "runtime.started" -> "runtime", "state.entry.changed" -> "state"
   */
  function extractTopic(eventType: string): string {
    const dotIdx = eventType.indexOf(".");
    return dotIdx >= 0 ? eventType.slice(0, dotIdx) : eventType;
  }

  async function connect(): Promise<void> {
    if (closed) return;

    abortController = new AbortController();
    setState(connectionState === "connecting" ? "connecting" : "reconnecting");

    try {
      const res = await fetch(buildUrl(), {
        signal: abortController.signal,
        headers: {
          Accept: "text/event-stream",
        },
      });

      if (!res.ok) {
        throw new Error(
          `SSE stream ${res.status}: ${await res.text().catch(() => "")}`,
        );
      }

      // Connected successfully — reset backoff
      setState("connected");
      backoffMs = INITIAL_BACKOFF_MS;

      await readSseStream({
        response: res,
        signal: abortController.signal,
        parse: (data, message) => {
          const parsed = parseJsonSseData<Record<string, unknown>>(data);
          if (!parsed) return undefined;
          if (message.id) lastEventId = message.id;

          const eventType =
            message.event || (parsed.type as string) || "unknown";
          const topic = extractTopic(eventType);

          return {
            id: message.id || (parsed.id as string) || "",
            topic,
            type: eventType,
            sessionId: (parsed.sessionId as string) || sessionId,
            timestamp: (parsed.timestamp as string) || new Date().toISOString(),
            payload: (parsed.payload as Record<string, unknown>) || parsed,
          };
        },
        onMessage: dispatch,
      });

      // Stream ended normally — reconnect unless closed
      if (!closed) {
        scheduleReconnect();
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // Intentional abort from close() — don't reconnect
        return;
      }
      if (!closed) {
        scheduleReconnect();
      }
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    setState("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
  }

  // Start the connection
  void connect();

  return {
    get state() {
      return connectionState;
    },

    on(topic: string, handler: SubscriptionEventHandler): void {
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
      }
      set.add(handler);
    },

    off(topic: string, handler: SubscriptionEventHandler): void {
      const set = handlers.get(topic);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          handlers.delete(topic);
        }
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      setState("closed");
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      handlers.clear();
    },
  };
}
