/**
 * Character REST management API compatibility tests.
 *
 * These routes are retained for lightweight API/client management even though
 * plugin runtimes should prefer the create/update/list/get-character tools.
 * The tests lock current wire behavior so future pipeline refactors can remain
 * endpoint-compatible.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { characterRoutes } from "../../src/routes/api/characters.js";

function buildApp(store: DataStore): Hono {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("store", store);
		await next();
	});
	app.route("/api/sessions", characterRoutes);
	return app;
}

describe("Character REST API routes", () => {
	let store: DataStore;
	let app: Hono;
	const sessionId = "sess-chars";

	beforeEach(async () => {
		store = createMemoryStore();
		app = buildApp(store);
		await store.createSession({
			id: sessionId,
			worldId: "cloudmere",
			status: "active",
			turnCount: 1,
			preGameCompleted: [],
			locale: "zh-CN",
			activePlugins: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	});

	it("GET returns all characters for the session", async () => {
		await store.upsertCharacter({
			id: "char-1",
			sessionId,
			name: "Ari",
			type: "player",
			description: "Explorer",
			fields: { class: "Ranger" },
			version: 1,
			createdAt: "2026-04-27T00:00:00.000Z",
			updatedAt: "2026-04-27T00:00:00.000Z",
		});

		const res = await app.request(`/api/sessions/${sessionId}/characters`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: Array<Record<string, unknown>>;
		};
		expect(body.items).toHaveLength(1);
		expect(body.items[0]).toMatchObject({
			id: "char-1",
			sessionId,
			name: "Ari",
			type: "player",
			description: "Explorer",
			fields: { class: "Ranger" },
			version: 1,
		});
	});

	it("POST upserts a character with defaults and returns the stored record", async () => {
		const res = await app.request(`/api/sessions/${sessionId}/characters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				id: "char-2",
				name: "Mira",
				fields: { courage: 7 },
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			id: "char-2",
			sessionId,
			name: "Mira",
			type: "npc",
			fields: { courage: 7 },
			version: 1,
		});
		expect(typeof body.createdAt).toBe("string");
		expect(typeof body.updatedAt).toBe("string");

		const stored = await store.listCharacters(sessionId);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ id: "char-2", name: "Mira" });
	});

	it("POST returns 400 when required fields are missing", async () => {
		const missingId = await app.request(
			`/api/sessions/${sessionId}/characters`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "No ID" }),
			},
		);
		expect(missingId.status).toBe(400);
		expect(await missingId.json()).toEqual({
			error: "id (string) is required",
		});

		const missingName = await app.request(
			`/api/sessions/${sessionId}/characters`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: "char-missing-name" }),
			},
		);
		expect(missingName.status).toBe(400);
		expect(await missingName.json()).toEqual({
			error: "name (string) is required",
		});
	});

	it("returns 404 for unknown sessions", async () => {
		const getRes = await app.request("/api/sessions/missing/characters");
		expect(getRes.status).toBe(404);

		const postRes = await app.request("/api/sessions/missing/characters", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "char-x", name: "Ghost" }),
		});
		expect(postRes.status).toBe(404);
	});
});
