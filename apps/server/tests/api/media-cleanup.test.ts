/**
 * Gate behaviour for `POST /api/media/cleanup` (audit P1/P2).
 *
 * Covers:
 *   1. env flag missing  → 403 forbidden
 *   2. env flag on, dryRun:false, no confirm header → 400 invalid_request
 *   3. env flag on, dryRun:true                       → 200 (inventory only)
 *   4. env flag on, dryRun:false + confirm header     → 200 + cleanup ran
 *   5. scanLimit overflow                              → 400 limit_exceeded
 *   6. concurrent runs                                 → second hits singleFlight
 *   7. DEPLOYMENT_TIER=commercial                      → 503 unavailable
 *
 * The happy-path tests in `media.test.ts` assume the gate is open and set
 * `COVEL_MEDIA_CLEANUP_ENABLED=true` themselves. These tests own the gate
 * surface explicitly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
	createMemoryMediaStore,
	createMemoryStore,
	type DataStore,
	type MediaStore,
	type SessionRecord,
} from "@covel/store";
import { mediaRoutes } from "../../src/routes/api/media.js";

function makeSession(id: string, worldId = "world-1"): SessionRecord {
	const now = new Date().toISOString();
	return {
		id,
		worldId,
		status: "active",
		turnCount: 0,
		preGameCompleted: [],
		activePlugins: [],
		createdAt: now,
		updatedAt: now,
	};
}

function createTestApp(
	mediaStore: MediaStore,
	dataStore: DataStore = createMemoryStore(),
): Hono {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("store", dataStore);
		c.set("mediaStore", mediaStore);
		await next();
	});
	app.route("/api/media", mediaRoutes);
	return app;
}

const ORIGINAL_FLAG = process.env.COVEL_MEDIA_CLEANUP_ENABLED;
const ORIGINAL_TIER = process.env.DEPLOYMENT_TIER;

function restoreEnv(): void {
	if (ORIGINAL_FLAG === undefined) {
		delete process.env.COVEL_MEDIA_CLEANUP_ENABLED;
	} else {
		process.env.COVEL_MEDIA_CLEANUP_ENABLED = ORIGINAL_FLAG;
	}
	if (ORIGINAL_TIER === undefined) {
		delete process.env.DEPLOYMENT_TIER;
	} else {
		process.env.DEPLOYMENT_TIER = ORIGINAL_TIER;
	}
}

describe("POST /api/media/cleanup gate", () => {
	beforeEach(() => {
		delete process.env.COVEL_MEDIA_CLEANUP_ENABLED;
		delete process.env.DEPLOYMENT_TIER;
	});
	afterEach(() => {
		restoreEnv();
	});

	it("returns 403 forbidden when COVEL_MEDIA_CLEANUP_ENABLED is unset", async () => {
		const app = createTestApp(createMemoryMediaStore());
		const res = await app.request("/api/media/cleanup", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code: string; error: string };
		expect(body.code).toBe("forbidden");
		expect(body.error).toContain("disabled");
	});

	it("returns 503 unavailable when DEPLOYMENT_TIER=commercial regardless of flag", async () => {
		process.env.COVEL_MEDIA_CLEANUP_ENABLED = "true";
		process.env.DEPLOYMENT_TIER = "commercial";
		const app = createTestApp(createMemoryMediaStore());
		const res = await app.request("/api/media/cleanup", {
			method: "POST",
			body: JSON.stringify({ dryRun: true }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(503);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("unavailable");
	});

	it("returns 400 invalid_request when dryRun:false missing confirmation header", async () => {
		process.env.COVEL_MEDIA_CLEANUP_ENABLED = "true";
		const app = createTestApp(createMemoryMediaStore());
		const res = await app.request("/api/media/cleanup", {
			method: "POST",
			body: JSON.stringify({ dryRun: false }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; error: string };
		expect(body.code).toBe("invalid_request");
		expect(body.error.toLowerCase()).toContain("confirmation header");
	});

	it("returns 200 for dryRun:true without side effects when flag is enabled", async () => {
		process.env.COVEL_MEDIA_CLEANUP_ENABLED = "true";
		const dataStore = createMemoryStore();
		const mediaStore = createMemoryMediaStore();
		const ref = await mediaStore.put(
			new Uint8Array([1, 2, 3]),
			"application/octet-stream",
		);

		const app = createTestApp(mediaStore, dataStore);
		const res = await app.request("/api/media/cleanup", {
			method: "POST",
			body: JSON.stringify({ dryRun: true }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			policy: { dryRun: boolean };
			result: { deleted: number };
		};
		expect(body.policy.dryRun).toBe(true);
		expect(body.result.deleted).toBe(0);
		expect(await mediaStore.exists(ref.id)).toBe(true);
	});

	it("runs destructive cleanup with X-Confirm-Cleanup: yes", async () => {
		process.env.COVEL_MEDIA_CLEANUP_ENABLED = "true";
		const dataStore = createMemoryStore();
		const mediaStore = createMemoryMediaStore();
		const ref = await mediaStore.put(
			new Uint8Array([7, 7, 7]),
			"application/octet-stream",
		);

		const app = createTestApp(mediaStore, dataStore);
		const res = await app.request("/api/media/cleanup", {
			method: "POST",
			body: JSON.stringify({ dryRun: false, maxBytes: 0 }),
			headers: {
				"content-type": "application/json",
				"x-confirm-cleanup": "yes",
			},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			policy: { dryRun: boolean };
			result: { deleted: number; deletedIds: string[] };
		};
		expect(body.policy.dryRun).toBe(false);
		expect(body.result.deleted).toBe(1);
		expect(body.result.deletedIds).toEqual([ref.id]);
		expect(await mediaStore.exists(ref.id)).toBe(false);
	});

	it("returns 400 limit_exceeded when scanLimit is below scanned row count", async () => {
		process.env.COVEL_MEDIA_CLEANUP_ENABLED = "true";
		const dataStore = createMemoryStore();
		await dataStore.createSession(makeSession("sess-A"));
		// Pump messages so scanLimit=1 trips after a bounded page, not after
		// materialising the entire table.
		for (let i = 0; i < 5; i += 1) {
			await dataStore.addMessage({
				id: `msg-${i}`,
				sessionId: "sess-A",
				role: "system",
				content: "",
				createdAt: new Date().toISOString(),
			});
		}

		const mediaStore = createMemoryMediaStore();
		const app = createTestApp(mediaStore, dataStore);
		const res = await app.request("/api/media/cleanup", {
			method: "POST",
			body: JSON.stringify({ dryRun: true, scanLimit: 1 }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; error: string };
		expect(body.code).toBe("limit_exceeded");
		expect(body.error).toContain("sess-A");
	});

	it("uses paginated store scans instead of loading all rows at once", async () => {
		process.env.COVEL_MEDIA_CLEANUP_ENABLED = "true";
		const dataStore = createMemoryStore();
		await dataStore.createSession(makeSession("sess-A"));
		for (let i = 0; i < 250; i += 1) {
			await dataStore.addMessage({
				id: `msg-${i}`,
				sessionId: "sess-A",
				role: "system",
				content: "",
				createdAt: new Date().toISOString(),
			});
		}

		const pageSizes: number[] = [];
		const originalListMessages = dataStore.listMessages.bind(dataStore);
		dataStore.listMessages = async (sessionId, pagination) => {
			const rows = await originalListMessages(sessionId, pagination);
			pageSizes.push(rows.length);
			return rows;
		};

		const app = createTestApp(createMemoryMediaStore(), dataStore);
		const res = await app.request("/api/media/cleanup", {
			method: "POST",
			body: JSON.stringify({ dryRun: true, scanLimit: 1_000 }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(pageSizes.length).toBeGreaterThan(1);
		expect(Math.max(...pageSizes)).toBeLessThanOrEqual(100);
	});

	it("returns 400 invalid_request when scanLimit is not a positive integer", async () => {
		process.env.COVEL_MEDIA_CLEANUP_ENABLED = "true";
		const app = createTestApp(createMemoryMediaStore());
		const res = await app.request("/api/media/cleanup", {
			method: "POST",
			body: JSON.stringify({ dryRun: true, scanLimit: -1 }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("invalid_request");
	});

	it("singleFlight: a second concurrent cleanup request is rejected", async () => {
		process.env.COVEL_MEDIA_CLEANUP_ENABLED = "true";
		const dataStore = createMemoryStore();
		const mediaStore = createMemoryMediaStore();

		// Wrap listSessions so we can hold the first request inside the route
		// while we fire the second one.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const originalListSessions = dataStore.listSessions.bind(dataStore);
		(
			dataStore as { listSessions: () => Promise<SessionRecord[]> }
		).listSessions = async () => {
			await gate;
			return originalListSessions();
		};

		const app = createTestApp(mediaStore, dataStore);
		const first = app.request("/api/media/cleanup", {
			method: "POST",
			body: JSON.stringify({ dryRun: true }),
			headers: { "content-type": "application/json" },
		});
		// Yield so the first request enters singleFlight before we launch the
		// second one.
		await new Promise<void>((resolve) => setImmediate(resolve));

		const second = await app.request("/api/media/cleanup", {
			method: "POST",
			body: JSON.stringify({ dryRun: true }),
			headers: { "content-type": "application/json" },
		});
		expect(second.status).toBe(429);
		const secondBody = (await second.json()) as { error: string };
		expect(secondBody.error.toLowerCase()).toContain("in progress");

		release();
		const firstRes = await first;
		expect(firstRes.status).toBe(200);
	});
});
