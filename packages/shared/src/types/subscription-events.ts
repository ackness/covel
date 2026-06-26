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
] as const;

export type SubscriptionTopic = (typeof SUBSCRIPTION_TOPICS)[number];

export interface SubscriptionEvent {
  readonly id: string; // monotonic sequence ID (e.g., "42")
  readonly topic: SubscriptionTopic;
  readonly type: string; // e.g., "runtime.started", "state.entry.changed"
  readonly sessionId: string;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SubscriptionFilter {
  readonly sessionId: string;
  readonly topics?: readonly SubscriptionTopic[];
  readonly lastEventId?: string;
}
