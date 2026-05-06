/**
 * Tests for the suspend/resume API routes (S4-T4).
 *
 * POST   /api/sessions/:id/resume
 * DELETE /api/sessions/:id/suspensions/:suspensionId
 * GET    /api/sessions/:id/suspensions
 *
 * Feature flag: COVEL_SUSPEND_V1=1 must be set for all three routes.
 * When the flag is off, all three endpoints return 503 (consistent
 * "feature disabled" semantics across the suspend surface).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
	createPluginRegistry,
	type PluginRegistry,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { resumeRoutes } from "../../src/routes/api/resume.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

// ── Helpers ──────────────────────────────────────────────────────────

type Deps = {
	store: DataStore;
	pluginRegistry: PluginRegistry;
	llmAdapter: { generate: () => Promise<unknown> };
	loadRuntimeFn: () => Promise<undefined>;
	toolExecutor: {
		execute: () => Promise<unknown>;
		getToolInfo: () => undefined;
	};
	getConfigFn: () => Record<string, unknown>;
	resolveModel: () => undefined;
};

function createTestApp(deps: Deps) {
	const app = new Hono<{
		Variables: {
			store: DataStore;
			pluginRegistry: PluginRegistry;
			llmAdapter: Deps["llmAdapter"];
			loadRuntimeFn: Deps["loadRuntimeFn"];
			toolExecutor: Deps["toolExecutor"];
			getConfigFn: Deps["getConfigFn"];
			resolveModel: Deps["resolveModel"];
		};
	}>();

	const sessionLock = createInProcessSessionLock();
	app.use("*", async (c, next) => {
		c.set("store", deps.store);
		c.set("pluginRegistry", deps.pluginRegistry);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		c.set("llmAdapter", deps.llmAdapter as any);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		c.set("loadRuntimeFn", deps.loadRuntimeFn as any);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		c.set("toolExecutor", deps.toolExecutor as any);
		c.set("getConfigFn", deps.getConfigFn);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		c.set("resolveModel", deps.resolveModel as any);
		c.set("sessionLock", sessionLock);
		await next();
	});

	app.route("/api/sessions", resumeRoutes);
	return app;
}

async function createSession(store: DataStore, sessionId = "sess-1") {
	await store.createSession({
		id: sessionId,
		worldId: "test-world",
		status: "active",
		turnCount: 1,
		preGameCompleted: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
}

async function createSuspension(
	store: DataStore,
	overrides?: Partial<{
		id: string;
		sessionId: string;
		resolvedAt: string;
		resumeSchema: unknown;
	}>,
) {
	const suspension = {
		id: overrides?.id ?? "susp-1",
		sessionId: overrides?.sessionId ?? "sess-1",
		turnId: "turn-1",
		runtimeId: "test-plugin",
		pluginId: "test-plugin",
		reason: "Need player input",
		resumeSchema: overrides?.resumeSchema ?? {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		},
		pendingContinuation: {
			messages: [{ role: "system", content: "You are a test agent." }],
			toolCallsSoFar: [],
			pendingProposals: [],
			suspendToolCallId: "tc-suspend-1",
		},
		createdAt: new Date().toISOString(),
		resolvedAt: overrides?.resolvedAt,
	};
	await store.saveSuspension(suspension);
	return suspension;
}

// Default LLM that returns a simple narrative on resume
function makeDefaultLLM() {
	return {
		generate: async () => ({
			content: '{"narrativeOutput": "Resume complete."}',
			toolCalls: [],
			finishReason: "stop",
			usage: { inputTokens: 5, outputTokens: 5 },
		}),
	};
}

const TEST_MANIFEST: RuntimeManifest = {
	name: "test-plugin",
	pluginId: "test-plugin",
	pluginType: "community" as const,
	priority: 500,
	trigger: { mode: "always" as const },
	model: "gpt-4o-mini",
	// This fixture emulates a narrator-style runtime that appends to the
	// main feed on resume. After 2026-04-24, only `outputKind: 'story'`
	// runtimes produce `narrative.append` proposals — other kinds keep
	// their text internal to the RuntimeResult.
	outputKind: "story" as const,
};

function makeDefaultDeps(store: DataStore, overrides?: Partial<Deps>): Deps {
	const pluginRegistry = createPluginRegistry();
	// Register the test plugin so resume route can find the runtime manifest
	pluginRegistry.register({
		id: "test-plugin",
		summary: {
			id: "test-plugin",
			name: "Test Plugin",
			description: "",
			version: "0.0.0",
			pluginType: "community",
			source: "community",
		},
		manifests: [
			{
				manifest: TEST_MANIFEST,
				promptTemplate: "Test prompt",
				references: [],
			},
		],
		loadedRuntimes: new Map(),
		status: "loaded",
	});

	return {
		store,
		pluginRegistry,
		llmAdapter: makeDefaultLLM(),
		loadRuntimeFn: async () =>
			({
				manifest: TEST_MANIFEST,
				promptTemplate: "Test prompt",
				references: [],
			}) as never,
		toolExecutor: {
			execute: async () => ({
				result: "{}",
				parsedResult: {},
				success: true,
				toolCallId: "",
				name: "",
			}),
			getToolInfo: () => undefined,
		},
		getConfigFn: () => ({}),
		resolveModel: () => undefined,
		...overrides,
	};
}

// ── Tests ─────────────────────────────────────────────────────────────

const originalEnv = process.env["COVEL_SUSPEND_V1"];

describe("Resume Routes — flag on (COVEL_SUSPEND_V1=1)", () => {
	let store: DataStore;

	beforeEach(async () => {
		process.env["COVEL_SUSPEND_V1"] = "1";
		store = createMemoryStore();
		await createSession(store);
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env["COVEL_SUSPEND_V1"];
		} else {
			process.env["COVEL_SUSPEND_V1"] = originalEnv;
		}
	});

	describe("POST /api/sessions/:id/resume", () => {
		it("returns 400 when X-Provider-Keys header is missing", async () => {
			const app = createTestApp(makeDefaultDeps(store));
			await createSuspension(store);

			const res = await app.request("/api/sessions/sess-1/resume", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					suspensionId: "susp-1",
					data: { name: "Alice" },
				}),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toMatch(/X-Provider-Keys/);
		});

		it("returns 400 when body is not valid JSON", async () => {
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/resume", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Provider-Keys": "dGVzdA==",
				},
				body: "not-json",
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toMatch(/JSON/i);
		});

		it("returns 400 when suspensionId is missing", async () => {
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/resume", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Provider-Keys": "dGVzdA==",
				},
				body: JSON.stringify({ data: { name: "Alice" } }),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toMatch(/suspensionId/);
		});

		it("returns 404 when session does not exist", async () => {
			const app = createTestApp(makeDefaultDeps(store));
			await createSuspension(store, { sessionId: "sess-1" });

			const res = await app.request("/api/sessions/sess-nonexistent/resume", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Provider-Keys": "dGVzdA==",
				},
				body: JSON.stringify({
					suspensionId: "susp-1",
					data: { name: "Alice" },
				}),
			});

			expect(res.status).toBe(404);
		});

		it("returns 404 when suspension does not exist", async () => {
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/resume", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Provider-Keys": "dGVzdA==",
				},
				body: JSON.stringify({
					suspensionId: "nonexistent-susp",
					data: { name: "Alice" },
				}),
			});

			expect(res.status).toBe(404);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toMatch(/not found/i);
		});

		it("returns 404 when suspension belongs to a different session", async () => {
			// Create suspension for sess-other
			await createSession(store, "sess-other");
			await createSuspension(store, {
				id: "susp-other",
				sessionId: "sess-other",
			});
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/resume", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Provider-Keys": "dGVzdA==",
				},
				body: JSON.stringify({
					suspensionId: "susp-other",
					data: { name: "Alice" },
				}),
			});

			expect(res.status).toBe(404);
		});

		it("returns 409 when suspension is already resolved (audit finding 2: idempotency)", async () => {
			await createSuspension(store, { resolvedAt: new Date().toISOString() });
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/resume", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Provider-Keys": "dGVzdA==",
				},
				body: JSON.stringify({
					suspensionId: "susp-1",
					data: { name: "Alice" },
				}),
			});

			// 409 Conflict: the resolved-already check and the atomic claim both
			// reject with "already resolved" — 409 distinguishes this from the
			// other 404 "not found" paths that cover missing sessions/suspensions.
			expect(res.status).toBe(409);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toMatch(/already resolved/i);
		});

		it("returns 400 when resume data fails schema validation", async () => {
			await createSuspension(store);
			const app = createTestApp(makeDefaultDeps(store));

			// Schema requires { name: string } but we pass { count: 42 }
			const res = await app.request("/api/sessions/sess-1/resume", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Provider-Keys": "dGVzdA==",
				},
				body: JSON.stringify({ suspensionId: "susp-1", data: { count: 42 } }),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toMatch(/validation/i);
		});

		it("returns 400 when resume data has wrong field type", async () => {
			await createSuspension(store, {
				resumeSchema: {
					type: "object",
					properties: { age: { type: "number" } },
				},
			});
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/resume", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Provider-Keys": "dGVzdA==",
				},
				body: JSON.stringify({
					suspensionId: "susp-1",
					data: { age: "not-a-number" },
				}),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toMatch(/validation/i);
		});

		it("returns 200 with result on successful resume", async () => {
			await createSuspension(store);
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/resume", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Provider-Keys": "dGVzdA==",
				},
				body: JSON.stringify({
					suspensionId: "susp-1",
					data: { name: "Alice" },
				}),
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.result).toBeDefined();
			expect((body.result as Record<string, unknown>).status).toBe("success");
			expect(body.events).toBeDefined();
			expect(body.events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "narrative.completed" }),
				]),
			);
		});

		it("commits resumed runtime output to the store before returning", async () => {
			await createSuspension(store);
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/resume", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Provider-Keys": "dGVzdA==",
				},
				body: JSON.stringify({
					suspensionId: "susp-1",
					data: { name: "Alice" },
				}),
			});

			expect(res.status).toBe(200);

			const messages = await store.listMessages("sess-1");
			expect(messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						content: "Resume complete.",
						role: "assistant",
					}),
				]),
			);
		});
	});

	describe("DELETE /api/sessions/:id/suspensions/:suspensionId", () => {
		it("returns 404 when suspension does not exist", async () => {
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request(
				"/api/sessions/sess-1/suspensions/nonexistent",
				{
					method: "DELETE",
				},
			);

			expect(res.status).toBe(404);
		});

		it("returns 200 with deleted: true when suspension is removed", async () => {
			await createSuspension(store);
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/suspensions/susp-1", {
				method: "DELETE",
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.deleted).toBe(true);
			expect(body.suspensionId).toBe("susp-1");
		});

		it("removes suspension from store after deletion", async () => {
			await createSuspension(store);
			const app = createTestApp(makeDefaultDeps(store));

			await app.request("/api/sessions/sess-1/suspensions/susp-1", {
				method: "DELETE",
			});

			const retrieved = await store.getSuspension("susp-1");
			expect(retrieved).toBeNull();
		});

		it("returns 404 when suspension belongs to a different session", async () => {
			await createSession(store, "sess-other");
			await createSuspension(store, {
				id: "susp-other",
				sessionId: "sess-other",
			});
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request(
				"/api/sessions/sess-1/suspensions/susp-other",
				{
					method: "DELETE",
				},
			);

			expect(res.status).toBe(404);
		});
	});

	describe("GET /api/sessions/:id/suspensions", () => {
		it("returns empty array when no suspensions exist", async () => {
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/suspensions");

			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.suspensions).toEqual([]);
		});

		it("returns 404 when session does not exist", async () => {
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-missing/suspensions");

			expect(res.status).toBe(404);
		});

		it("returns list of suspensions for the session", async () => {
			await createSuspension(store, { id: "susp-a" });
			await createSuspension(store, { id: "susp-b" });
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/suspensions");

			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			const suspensions = body.suspensions as unknown[];
			expect(suspensions).toHaveLength(2);
		});

		it("does not include suspensions from other sessions", async () => {
			await createSession(store, "sess-other");
			await createSuspension(store, { id: "susp-mine" });
			await createSuspension(store, {
				id: "susp-theirs",
				sessionId: "sess-other",
			});
			const app = createTestApp(makeDefaultDeps(store));

			const res = await app.request("/api/sessions/sess-1/suspensions");

			const body = (await res.json()) as Record<string, unknown>;
			const suspensions = body.suspensions as Array<Record<string, unknown>>;
			expect(suspensions).toHaveLength(1);
			expect(suspensions[0]!.id).toBe("susp-mine");
		});
	});
});

// ── Feature flag OFF ──────────────────────────────────────────────────

describe("Resume Routes — flag off (COVEL_SUSPEND_V1 != 1)", () => {
	let store: DataStore;

	beforeEach(async () => {
		process.env["COVEL_SUSPEND_V1"] = "0";
		store = createMemoryStore();
		await createSession(store);
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env["COVEL_SUSPEND_V1"];
		} else {
			process.env["COVEL_SUSPEND_V1"] = originalEnv;
		}
	});

	it("POST /resume returns 503 when flag is off", async () => {
		const app = createTestApp(makeDefaultDeps(store));
		await createSuspension(store);

		const res = await app.request("/api/sessions/sess-1/resume", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Provider-Keys": "dGVzdA==",
			},
			body: JSON.stringify({ suspensionId: "susp-1", data: { name: "Alice" } }),
		});

		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toMatch(/COVEL_SUSPEND_V1/);
	});

	it("DELETE /suspensions/:id returns 503 when flag is off", async () => {
		const app = createTestApp(makeDefaultDeps(store));
		await createSuspension(store);

		const res = await app.request("/api/sessions/sess-1/suspensions/susp-1", {
			method: "DELETE",
		});

		expect(res.status).toBe(503);
	});

	it("GET /suspensions returns 200 + empty list when flag is off", async () => {
		// The list endpoint is read-only hydration that runs on every session
		// restore. Returning 503 there pollutes the browser network panel even
		// though the web client treats failures as "no active suspensions".
		// A disabled flag means "no suspensions exist", which is functionally
		// correct as an empty list. Write paths (POST /resume, DELETE) keep
		// their 503 gate above.
		const app = createTestApp(makeDefaultDeps(store));

		const res = await app.request("/api/sessions/sess-1/suspensions");

		expect(res.status).toBe(200);
		const body = (await res.json()) as { suspensions: unknown[] };
		expect(body.suspensions).toEqual([]);
	});
});
