/**
 * EventBus — pending-queue and session-cleanup invariants.
 *
 * `event-bus.test.ts` covers basic emit/on/once. `event-bus-subscription.test.ts`
 * covers seq + ring buffer. This file pins:
 *  - `getPendingEvents` / `acknowledge` lifecycle
 *  - pending-queue overflow drops the OLDEST events (and warns)
 *  - `clearSession` resets seq counter AND drops the ring buffer AND
 *    drops pending entries (so a re-used sessionId starts clean)
 *  - wildcard `*` subscribers still fire when topic is e.g. 'foo.bar'
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CovelMessage } from "@covel/shared";
import { createEventBus, type EventBus } from "../src/event-bus.js";

const SESSION = "sess-pq";

function makeMessage(overrides?: Partial<CovelMessage>): CovelMessage {
	return {
		id: crypto.randomUUID(),
		type: "event",
		topic: "topic.x",
		payload: {},
		sessionId: SESSION,
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

describe("EventBus — pending queue lifecycle", () => {
	let bus: EventBus;
	beforeEach(() => {
		bus = createEventBus();
	});

	it("returns emitted events as pending until acknowledged", () => {
		const m1 = makeMessage();
		const m2 = makeMessage();
		bus.emit(m1);
		bus.emit(m2);

		const pending = bus.getPendingEvents(SESSION);
		expect(pending.map((p) => p.id).sort()).toEqual([m1.id, m2.id].sort());
	});

	it("acknowledge removes a single message; siblings remain pending", () => {
		const m1 = makeMessage();
		const m2 = makeMessage();
		bus.emit(m1);
		bus.emit(m2);

		bus.acknowledge(m1.id);

		const pending = bus.getPendingEvents(SESSION);
		expect(pending.map((p) => p.id)).toEqual([m2.id]);
	});

	it("acknowledge of an unknown id is a no-op", () => {
		const m1 = makeMessage();
		bus.emit(m1);
		bus.acknowledge("unknown-id-12345");
		expect(bus.getPendingEvents(SESSION)).toHaveLength(1);
	});

	it("acknowledge is idempotent — calling twice does not poison anyone else", () => {
		const m1 = makeMessage();
		const m2 = makeMessage();
		bus.emit(m1);
		bus.emit(m2);

		bus.acknowledge(m1.id);
		bus.acknowledge(m1.id); // repeat

		expect(bus.getPendingEvents(SESSION).map((p) => p.id)).toEqual([m2.id]);
	});

	it("returns an empty list for a session that never emitted", () => {
		expect(bus.getPendingEvents("never-existed")).toEqual([]);
	});
});

describe("EventBus — pending queue overflow", () => {
	it("drops the oldest events when pending exceeds the cap and warns", () => {
		// Cap is 1000 — we emit 1010 to force ten evictions. To avoid 10000
		// assertions, just pin the head/tail invariant.
		const bus = createEventBus();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const ids: string[] = [];
		for (let i = 0; i < 1010; i++) {
			const m = makeMessage();
			ids.push(m.id);
			bus.emit(m);
		}

		const pending = bus.getPendingEvents(SESSION);
		expect(pending).toHaveLength(1000);
		// First 10 ids should have been dropped; pending starts at id index 10.
		const pendingIds = new Set(pending.map((p) => p.id));
		for (let i = 0; i < 10; i++) {
			expect(pendingIds.has(ids[i])).toBe(false);
		}
		expect(pendingIds.has(ids[10])).toBe(true);
		expect(pendingIds.has(ids[1009])).toBe(true);

		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("EventBus — clearSession is fully resettable", () => {
	it("drops pending events, ring buffer, and seq counter so a new session starts clean", () => {
		const bus = createEventBus();
		bus.emit(makeMessage());
		bus.emit(makeMessage());

		expect(bus.getPendingEvents(SESSION)).toHaveLength(2);
		expect(bus.getEventsAfter(SESSION, 0)).toHaveLength(2);

		bus.clearSession(SESSION);

		expect(bus.getPendingEvents(SESSION)).toHaveLength(0);
		expect(bus.getEventsAfter(SESSION, 0)).toHaveLength(0);

		// Re-using the same sessionId restarts seq from 1 (the per-session counter
		// was wiped). Otherwise SSE clients that reconnect would see stale,
		// skipped seq values.
		const captured: string[] = [];
		bus.onEmit((e) => {
			if (e.sessionId === SESSION) captured.push(e.id);
		});
		bus.emit(makeMessage());
		expect(captured).toEqual(["1"]);
	});

	it("clearing one session does not touch another", () => {
		const bus = createEventBus();
		bus.emit(makeMessage({ sessionId: "a" }));
		bus.emit(makeMessage({ sessionId: "b" }));

		bus.clearSession("a");

		expect(bus.getPendingEvents("a")).toHaveLength(0);
		expect(bus.getPendingEvents("b")).toHaveLength(1);
		expect(bus.getEventsAfter("b", 0)).toHaveLength(1);
	});
});

describe("EventBus — wildcard handlers", () => {
	it("* handler fires for any topic in addition to the topic-specific handler", () => {
		const bus = createEventBus();
		const all = vi.fn();
		const onTopic = vi.fn();

		bus.on("*", all);
		bus.on("user.action", onTopic);

		bus.emit(makeMessage({ topic: "user.action" }));
		bus.emit(makeMessage({ topic: "system.tick" }));

		expect(onTopic).toHaveBeenCalledOnce();
		expect(all).toHaveBeenCalledTimes(2);
	});

	it('emitting topic="*" does NOT cause double-fan-out to wildcard subscribers', () => {
		// The "topic === '*'" branch in emit() is a guard against fan-out
		// duplication when somebody emits with the wildcard literal as topic.
		const bus = createEventBus();
		const wildcard = vi.fn();
		bus.on("*", wildcard);
		bus.emit(makeMessage({ topic: "*" }));
		// The handler runs once because '*' === message.topic, not twice.
		expect(wildcard).toHaveBeenCalledOnce();
	});
});
