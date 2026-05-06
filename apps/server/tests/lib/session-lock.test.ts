/**
 * Unit tests for the in-process SessionLock.
 *
 * Validates the semantics documented on `createInProcessSessionLock`:
 *   - same-session calls are strictly serialized
 *   - different-session calls run concurrently
 *   - exceptions in `fn` release the slot so subsequent callers proceed
 *   - map entries are cleaned up when no successor is queued
 *
 * The PG advisory-lock variant is covered separately in
 * `tests/integration/pg-session-lock.test.ts` (skipped when DATABASE_URL
 * is not set).
 */

import { describe, it, expect } from "vitest";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

describe("createInProcessSessionLock", () => {
	it("serializes same-session calls in submission order", async () => {
		const lock = createInProcessSessionLock();
		const log: string[] = [];

		const a = lock.withLock("sess-1", async () => {
			log.push("A-start");
			await new Promise((r) => setTimeout(r, 40));
			log.push("A-end");
		});
		const b = lock.withLock("sess-1", async () => {
			log.push("B-start");
			log.push("B-end");
		});
		const c = lock.withLock("sess-1", async () => {
			log.push("C-start");
			log.push("C-end");
		});

		await Promise.all([a, b, c]);

		expect(log).toEqual([
			"A-start",
			"A-end",
			"B-start",
			"B-end",
			"C-start",
			"C-end",
		]);
	});

	it("runs different-session calls concurrently", async () => {
		const lock = createInProcessSessionLock();
		const start = Date.now();

		await Promise.all([
			lock.withLock("sess-1", () => new Promise((r) => setTimeout(r, 50))),
			lock.withLock("sess-2", () => new Promise((r) => setTimeout(r, 50))),
			lock.withLock("sess-3", () => new Promise((r) => setTimeout(r, 50))),
		]);

		// Sequential execution would take ≥150ms; concurrent ~50ms. Give a
		// comfortable ceiling to avoid CI flake while still catching accidental
		// serialization (e.g. a global lock).
		expect(Date.now() - start).toBeLessThan(120);
	});

	it("releases the slot when fn throws so successors proceed", async () => {
		const lock = createInProcessSessionLock();
		const log: string[] = [];

		const failing = lock.withLock("sess-err", async () => {
			log.push("A-start");
			throw new Error("boom");
		});
		const next = lock.withLock("sess-err", async () => {
			log.push("B-start");
			log.push("B-end");
		});

		await expect(failing).rejects.toThrow("boom");
		await next;

		expect(log).toEqual(["A-start", "B-start", "B-end"]);
	});

	it("cleans up the map entry when no successor is queued", async () => {
		const lock = createInProcessSessionLock();
		expect(lock._sizeForTests()).toBe(0);

		await lock.withLock("sess-x", async () => {
			// While fn runs, the map MUST contain this session's chain.
			expect(lock._sizeForTests()).toBe(1);
		});

		// Post-completion the entry should be GC'd — otherwise the map grows
		// unboundedly as sessions come and go on a long-running server.
		expect(lock._sizeForTests()).toBe(0);
	});

	it("propagates fn return value to the caller", async () => {
		const lock = createInProcessSessionLock();
		const result = await lock.withLock("sess-ret", async () => 42);
		expect(result).toBe(42);
	});
});
