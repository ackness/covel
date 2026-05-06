/**
 * Subscription event types for unified real-time event streaming.
 */

export type SubscriptionTopic =
	| "runtime"
	| "state"
	| "game"
	| "plugin"
	| "session"
	| "store"
	| "system";

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
