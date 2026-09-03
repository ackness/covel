/**
 * Subscription event types for unified real-time event streaming.
 */

/**
 * The closed set of topics exposed by the `/api/events/stream` subscription
 * channel. Single source of truth: `subscribe.ts` derives its `VALID_TOPICS`
 * guard from this array, so the route accepts exactly the topics declared here
 * and they cannot drift apart.
 *
 * `trace` and `hooks` are runtime-internal observability topics: the
 * TurnEmitter (`_subTopic: "trace"`) and the hook pipeline (`_subTopic:
 * "hooks"`) emit them through the shared EventBus, and the /debug timeline
 * consumes them. They are intentionally subscribable here so a client can opt
 * in explicitly (previously they were emitted but rejected by the guard, so
 * `topics=trace` returned 400 while a no-filter subscription still received
 * them — that inconsistency is what this list closes).
 */
export const SUBSCRIPTION_TOPICS = [
  "runtime",
  "state",
  "game",
  "plugin",
  "session",
  "store",
  "system",
  "trace",
  "hooks",
  "job",
] as const;

export type SubscriptionTopic = (typeof SUBSCRIPTION_TOPICS)[number];

export interface SubscriptionEvent {
  /**
   * Wire event id: `${epoch}:${seq}`. `seq` is a per-session monotonic
   * counter; `epoch` changes whenever the server-side session replay state is
   * (re)created (process restart, eviction), so ids are never reused across
   * generations. Parse with {@link parseSubscriptionEventId}; compare epochs
   * as opaque strings — an epoch change means the client's cursor is stale.
   */
  readonly id: string;
  readonly topic: SubscriptionTopic;
  readonly type: string; // e.g., "runtime.started", "state.entry.changed"
  readonly sessionId: string;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Parsed `${epoch}:${seq}` subscription event id (SSE `lastEventId` cursor). */
export interface SubscriptionEventCursor {
  readonly epoch: string;
  readonly seq: number;
}

/**
 * Parse a `${epoch}:${seq}` wire event id. Returns undefined for malformed or
 * legacy plain-number ids — the server answers those with a `system.reset`
 * frame, so callers can treat "unparseable" as "cursor is stale".
 */
export function parseSubscriptionEventId(
  id: string,
): SubscriptionEventCursor | undefined {
  const sep = id.lastIndexOf(":");
  if (sep <= 0 || sep === id.length - 1) return undefined;
  const seq = Number(id.slice(sep + 1));
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined;
  return { epoch: id.slice(0, sep), seq };
}

export interface SubscriptionFilter {
  readonly sessionId: string;
  readonly topics?: readonly SubscriptionTopic[];
  readonly lastEventId?: string;
}
