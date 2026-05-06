/**
 * Working Memory REST API route tests (S3-T3).
 *
 * Tests the PUT/GET/DELETE round-trip for /api/sessions/:id/working-memory/:scope/:key
 * and the feature-flag gate (404 when COVEL_WORKING_MEMORY_V1 is unset).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { workingMemoryRoutes } from "../../src/routes/api/working-memory.js";

function createTestApp(store: DataStore): Hono {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("store", store);
		await next();
	});
	app.route("/api/sessions", workingMemoryRoutes);
	return app;
}

describe("Working Memory API routes", () => {
	let store: DataStore;
	let app: Hono;
	let originalFlag: string | undefined;
	const SESSION_ID = "wm-route-sess";

	beforeEach(async () => {
		originalFlag = process.env.COVEL_WORKING_MEMORY_V1;
		process.env.COVEL_WORKING_MEMORY_V1 = "1";

		store = createMemoryStore();
		await store.createSession({
			id: SESSION_ID,
			worldId: "world-1",
			status: "active",
			turnCount: 1,
			preGameCompleted: [],
			locale: "en",
			activePlugins: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});

		app = createTestApp(store);
	});

	afterEach(async () => {
		if (originalFlag === undefined) {
			delete process.env.COVEL_WORKING_MEMORY_V1;
		} else {
			process.env.COVEL_WORKING_MEMORY_V1 = originalFlag;
		}
		await store.close();
	});

	describe("PUT → GET → DELETE round-trip", () => {
		it("PUT creates a working memory entry", async () => {
			const res = await app.request(
				`/api/sessions/${SESSION_ID}/working-memory/player/prefs`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ value: { theme: "dark" } }),
				},
			);
			expect(res.status).toBe(200);
			const body = await res.json<Record<string, unknown>>();
			expect(body.success).toBe(true);
			expect(body.scope).toBe("player");
			expect(body.key).toBe("prefs");
		});

		it("GET returns all entries for a session", async () => {
			await store.upsertWorkingMemory({
				id: "wm-1",
				sessionId: SESSION_ID,
				scope: "player",
				key: "prefs",
				value: { theme: "dark" },
				updatedAt: new Date().toISOString(),
			});
			await store.upsertWorkingMemory({
				id: "wm-2",
				sessionId: SESSION_ID,
				scope: "story",
				key: "questLog",
				value: [],
				updatedAt: new Date().toISOString(),
			});

			const res = await app.request(
				`/api/sessions/${SESSION_ID}/working-memory`,
			);
			expect(res.status).toBe(200);
			const body = await res.json<{
				entries: Array<Record<string, unknown>>;
			}>();
			expect(body.entries).toHaveLength(2);
		});

		it("DELETE removes the targeted entry", async () => {
			await store.upsertWorkingMemory({
				id: "wm-del",
				sessionId: SESSION_ID,
				scope: "player",
				key: "temp",
				value: "to-be-deleted",
				updatedAt: new Date().toISOString(),
			});

			const deleteRes = await app.request(
				`/api/sessions/${SESSION_ID}/working-memory/player/temp`,
				{ method: "DELETE" },
			);
			expect(deleteRes.status).toBe(200);

			const entry = await store.getWorkingMemory(SESSION_ID, "player", "temp");
			expect(entry).toBeNull();
		});

		it("PUT + GET full round-trip", async () => {
			// PUT
			await app.request(
				`/api/sessions/${SESSION_ID}/working-memory/shared/goal`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ value: "find the artifact" }),
				},
			);

			// GET list
			const listRes = await app.request(
				`/api/sessions/${SESSION_ID}/working-memory`,
			);
			const body = await listRes.json<{
				entries: Array<{ scope: string; key: string; value: unknown }>;
			}>();
			const entry = body.entries.find(
				(e) => e.key === "goal" && e.scope === "shared",
			);
			expect(entry).toBeDefined();
			expect(entry!.value).toBe("find the artifact");
		});
	});

	describe("Feature flag OFF (404 on all routes)", () => {
		beforeEach(() => {
			delete process.env.COVEL_WORKING_MEMORY_V1;
		});

		it("GET /working-memory returns 404", async () => {
			const res = await app.request(
				`/api/sessions/${SESSION_ID}/working-memory`,
			);
			expect(res.status).toBe(404);
		});

		it("PUT /working-memory/:scope/:key returns 404", async () => {
			const res = await app.request(
				`/api/sessions/${SESSION_ID}/working-memory/player/key`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ value: "x" }),
				},
			);
			expect(res.status).toBe(404);
		});

		it("DELETE /working-memory/:scope/:key returns 404", async () => {
			const res = await app.request(
				`/api/sessions/${SESSION_ID}/working-memory/player/key`,
				{ method: "DELETE" },
			);
			expect(res.status).toBe(404);
		});
	});

	describe("Validation", () => {
		it("PUT with invalid scope returns 400", async () => {
			const res = await app.request(
				`/api/sessions/${SESSION_ID}/working-memory/invalid/key`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ value: 1 }),
				},
			);
			expect(res.status).toBe(400);
		});

		it("PUT for unknown session returns 404", async () => {
			const res = await app.request(
				"/api/sessions/nonexistent-session/working-memory/player/key",
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ value: 1 }),
				},
			);
			expect(res.status).toBe(404);
		});
	});
});
