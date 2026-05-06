/**
 * API Subscription routes — unified SSE stream with topic filtering and replay.
 *
 * GET /stream?sessionId=xxx&topics=runtime,state&lastEventId=xxx
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "@covel/events";
import type { DataStore } from "@covel/store";
import type { SubscriptionTopic } from "@covel/shared";

type Env = {
	Variables: {
		store: DataStore;
		eventBus: EventBus;
	};
};

export const subscribeRoutes = new Hono<Env>();

/**
 * Derive the SSE event field name from a SubscriptionEvent.
 *
 * EventBus normalises `payload._subType` onto `event.type` before handlers
 * run (see packages/events/src/event-bus.ts), so `event.type` already holds
 * the full semantic type (`plugin-data.changed`, `world.dimensions.changed`,
 * `runtime.started`, …). Emit it verbatim — any rewriting here silently
 * drops subType segments and breaks the frontend switch matchers that route
 * plugin panels and world updates.
 *
 * Exported for regression tests (tests/api/subscribe-event-name.test.ts).
 */
export function deriveSseEventName(event: {
	topic: string;
	type: string;
	payload?: Record<string, unknown>;
}): string {
	return event.type;
}

// GET /events/stream?sessionId=xxx&topics=runtime,state&lastEventId=xxx
subscribeRoutes.get("/stream", async (c) => {
	const store = c.get("store");
	const eventBus = c.get("eventBus");

	const sessionId = c.req.query("sessionId");
	if (!sessionId) return c.json({ error: "sessionId required" }, 400);

	const session = await store.getSession(sessionId);
	if (!session) return c.json({ error: "Session not found" }, 404);

	const topicsParam = c.req.query("topics");
	// M2: Validate topics parameter against known SubscriptionTopic values
	const VALID_TOPICS = new Set<string>([
		"runtime",
		"state",
		"game",
		"plugin",
		"session",
		"store",
		"system",
	]);
	if (topicsParam) {
		const parsed = topicsParam.split(",").map((t) => t.trim());
		const invalid = parsed.filter((t) => !VALID_TOPICS.has(t));
		if (invalid.length > 0) {
			return c.json({ error: `Invalid topics: ${invalid.join(", ")}` }, 400);
		}
	}
	const topics = topicsParam
		? new Set(
				topicsParam.split(",").map((t) => t.trim()) as SubscriptionTopic[],
			)
		: null; // null = all topics

	const lastEventId = c.req.query("lastEventId");

	return streamSSE(c, async (stream) => {
		let seq = 0;

		// Send connected event
		await stream.writeSSE({
			id: String(seq++),
			event: "system.connected",
			data: JSON.stringify({
				sessionId,
				topics: topics ? [...topics] : "all",
				timestamp: new Date().toISOString(),
			}),
		});

		// Replay missed events if lastEventId provided
		if (lastEventId) {
			const afterSeq = parseInt(lastEventId, 10);
			if (!isNaN(afterSeq)) {
				const missed = eventBus.getEventsAfter(sessionId, afterSeq);
				for (const event of missed) {
					if (!topics || topics.has(event.topic)) {
						await stream.writeSSE({
							id: event.id,
							event: deriveSseEventName(event),
							data: JSON.stringify(event),
						});
					}
				}
			}
		}

		// Register live event callback
		const unsubscribe = eventBus.onEmit((event) => {
			if (event.sessionId !== sessionId) return;
			if (topics && !topics.has(event.topic)) return;

			stream
				.writeSSE({
					id: event.id,
					event: deriveSseEventName(event),
					data: JSON.stringify(event),
				})
				.catch(() => {
					// Connection closed — cleanup will happen via abort
				});
		});

		// Heartbeat every 30 seconds
		const heartbeatInterval = setInterval(async () => {
			try {
				await stream.writeSSE({
					event: "system.heartbeat",
					data: JSON.stringify({ timestamp: new Date().toISOString() }),
				});
			} catch {
				clearInterval(heartbeatInterval);
			}
		}, 30000);

		// Keep the stream open until the client disconnects.
		// Without this, the async callback returns immediately and Hono closes the stream.
		await new Promise<void>((resolve) => {
			stream.onAbort(() => {
				unsubscribe();
				clearInterval(heartbeatInterval);
				resolve();
			});
		});
	});
});
