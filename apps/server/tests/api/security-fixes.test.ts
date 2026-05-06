/**
 * TDD tests for code review fixes (CRITICAL + HIGH issues).
 *
 * RED phase: all tests should FAIL before fixes are applied.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createStateManager, type StateManager } from "@covel/state";
import {
	createPluginRegistry,
	type PluginRegistry,
} from "@covel/plugin-loader";
import { createMemoryStore, type DataStore } from "@covel/store";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { stateRoutes } from "../../src/routes/api/state.js";
import { rateLimiter } from "../../src/middleware/rate-limit.js";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";

// ── Helpers ─────────────────────────────────────────────────────

function createTestApp(deps: {
	store: DataStore;
	stateManager: StateManager;
	pluginRegistry: PluginRegistry;
}) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("store", deps.store);
		c.set("stateManager", deps.stateManager);
		c.set("pluginRegistry", deps.pluginRegistry);
		await next();
	});
	app.route("/api/sessions", sessionRoutes);
	app.route("/api/sessions", stateRoutes);
	return app;
}

async function json(res: Response): Promise<unknown> {
	return res.json();
}

async function createSession(app: Hono, body: Record<string, unknown> = {}) {
	const res = await app.request("/api/sessions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return json(res) as Promise<{ id: string }>;
}

// ── CRITICAL #1: Client-supplied session ID validation ──────────

describe("[HIGH] Client-supplied session ID validation", () => {
	let app: Hono;

	beforeEach(() => {
		const store = createMemoryStore();
		app = createTestApp({
			store,
			stateManager: createStateManager(store),
			pluginRegistry: createPluginRegistry(),
		});
	});

	it("rejects session ID with path traversal characters", async () => {
		const res = await app.request("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "../../etc/passwd" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects session ID with special characters", async () => {
		const res = await app.request("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "<script>alert(1)</script>" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects session ID exceeding max length", async () => {
		const res = await app.request("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "a".repeat(129) }),
		});
		expect(res.status).toBe(400);
	});

	it("accepts valid custom session ID", async () => {
		const res = await app.request("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "my-custom-session-01" }),
		});
		expect(res.status).toBe(200);
		const body = (await json(res)) as { id: string };
		expect(body.id).toBe("my-custom-session-01");
	});
});

// ── CRITICAL #2: PUT /state-snapshot must not silently discard ───

describe("[CRITICAL] PUT /state-snapshot returns 501", () => {
	let app: Hono;

	beforeEach(() => {
		const store = createMemoryStore();
		app = createTestApp({
			store,
			stateManager: createStateManager(store),
			pluginRegistry: createPluginRegistry(),
		});
	});

	it("returns 501 Not Implemented instead of silent 200", async () => {
		const { id } = await createSession(app);
		const res = await app.request(`/api/sessions/${id}/state-snapshot`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ character: { hp: 100 } }),
		});
		// Must NOT return 200 ok: true (silent discard)
		expect(res.status).toBe(501);
		const body = (await json(res)) as Record<string, unknown>;
		expect(body.error).toBeDefined();
	});
});

describe("[P2] rate limiter proxy trust", () => {
	let savedTrustedProxyIps: string | undefined;

	beforeEach(() => {
		savedTrustedProxyIps = process.env.TRUSTED_PROXY_IPS;
	});

	afterEach(() => {
		if (savedTrustedProxyIps === undefined)
			delete process.env.TRUSTED_PROXY_IPS;
		else process.env.TRUSTED_PROXY_IPS = savedTrustedProxyIps;
	});

	function requestFrom(remote: string, forwarded: string): Request {
		const req = new Request("http://localhost/limited", {
			headers: { "X-Forwarded-For": forwarded },
		});
		Object.defineProperty(req, "connInfo", {
			value: { remote: { address: remote } },
		});
		return req;
	}

	it("ignores forged forwarded headers when the remote address is untrusted", async () => {
		delete process.env.TRUSTED_PROXY_IPS;
		const app = new Hono();
		app.use("/limited", rateLimiter({ max: 1, windowMs: 60_000 }));
		app.get("/limited", (c) => c.text("ok"));

		const first = await app.request(
			requestFrom("203.0.113.10", "198.51.100.1"),
		);
		const second = await app.request(
			requestFrom("203.0.113.10", "198.51.100.2"),
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(429);
	});

	it("uses forwarded headers when the remote address is explicitly trusted", async () => {
		process.env.TRUSTED_PROXY_IPS = "127.0.0.1";
		const app = new Hono();
		app.use("/limited", rateLimiter({ max: 1, windowMs: 60_000 }));
		app.get("/limited", (c) => c.text("ok"));

		const first = await app.request(requestFrom("127.0.0.1", "198.51.100.1"));
		const second = await app.request(requestFrom("127.0.0.1", "198.51.100.2"));

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
	});
});

describe("[P2] provider keys raw exposure", () => {
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {
			COVEL_DESKTOP_REST_TOKEN: process.env.COVEL_DESKTOP_REST_TOKEN,
			OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		};
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("returns masked availability without desktop bearer token", async () => {
		process.env.COVEL_DESKTOP_REST_TOKEN = "desktop-token";
		process.env.OPENAI_API_KEY = "sk-openai-secret";
		const app = new Hono();
		app.route(
			"/",
			createMiscApiRoutes(
				makeAiStackStub(),
				createPluginRegistry(),
				createMemoryStore(),
			),
		);

		const res = await app.request("http://localhost/api/provider-keys");
		const body = (await res.json()) as {
			keys: Record<string, string>;
			providers: Record<string, { configured: boolean; masked: string }>;
		};

		expect(res.status).toBe(200);
		expect(body.keys).toEqual({});
		expect(body.providers.openai).toMatchObject({ configured: true });
		expect(body.providers.openai.masked).toContain("...");
	});

	it("returns raw keys with the desktop bearer token", async () => {
		process.env.COVEL_DESKTOP_REST_TOKEN = "desktop-token";
		process.env.OPENAI_API_KEY = "sk-openai-secret";
		const app = new Hono();
		app.route(
			"/",
			createMiscApiRoutes(
				makeAiStackStub(),
				createPluginRegistry(),
				createMemoryStore(),
			),
		);

		const res = await app.request("http://localhost/api/provider-keys", {
			headers: { Authorization: "Bearer desktop-token" },
		});
		const body = (await res.json()) as { keys: Record<string, string> };

		expect(res.status).toBe(200);
		expect(body.keys.openai).toBe("sk-openai-secret");
	});
});

function makeAiStackStub() {
	return {
		slotRegistry: {
			listSlots: () => ({}),
		},
		presetRegistry: {
			listPresets: () => [],
		},
	} as never;
}

// ── HIGH: plugins/disable must validate pluginId ────────────────

describe("[HIGH] plugins/disable validates pluginId", () => {
	let app: Hono;

	beforeEach(() => {
		const store = createMemoryStore();
		app = createTestApp({
			store,
			stateManager: createStateManager(store),
			pluginRegistry: createPluginRegistry(),
		});
	});

	it("rejects missing pluginId", async () => {
		const { id } = await createSession(app);
		const res = await app.request(`/api/sessions/${id}/plugins/disable`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects empty pluginId", async () => {
		const { id } = await createSession(app);
		const res = await app.request(`/api/sessions/${id}/plugins/disable`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pluginId: "" }),
		});
		expect(res.status).toBe(400);
	});
});

// ── HIGH: state-patches IDs must be stable ──────────────────────

describe("[HIGH] state-patches returns stable IDs", () => {
	let app: Hono;
	let stateManager: StateManager;

	beforeEach(async () => {
		const store = createMemoryStore();
		stateManager = createStateManager(store);
		app = createTestApp({
			store,
			stateManager,
			pluginRegistry: createPluginRegistry(),
		});
	});

	it("generates unique IDs with timestamp, not array index", async () => {
		const { id } = await createSession(app);

		await stateManager.createTable(id, {
			name: "character",
			fields: [{ name: "hp", type: "integer", default: 100 }],
		});
		await stateManager.setValue(id, "character", "hp", 80, {
			changedBy: "test",
			turnId: "turn-1",
			reason: "damage",
		});

		const res = await app.request(`/api/sessions/${id}/state-patches`);
		expect(res.status).toBe(200);
		const patches = (await json(res)) as Array<{
			id: string;
			createdAt: string;
		}>;
		expect(patches).toHaveLength(1);
		// ID should NOT be "character.hp.0" (array index pattern)
		expect(patches[0].id).not.toMatch(/\.\d+$/);
		// ID should contain a timestamp or be otherwise stable
		expect(patches[0].createdAt).toBeDefined();
	});
});

// ── HIGH: POST /sessions activate-after-persist ordering ────────

describe("[HIGH] Plugin activation happens after session persist", () => {
	let app: Hono;
	let store: DataStore;
	let pluginRegistry: PluginRegistry;

	beforeEach(() => {
		store = createMemoryStore();
		pluginRegistry = createPluginRegistry();
		app = createTestApp({
			store,
			stateManager: createStateManager(store),
			pluginRegistry,
		});
	});

	it("session exists in store when plugins array is non-empty", async () => {
		// Register a mock plugin so activate doesn't silently skip
		pluginRegistry.register({
			id: "test-plugin",
			summary: {
				id: "test-plugin",
				name: "Test",
				description: "",
				pluginType: "plugin",
				runtimeCount: 0,
			},
			loadedRuntimes: new Map(),
			status: "registered",
		});

		const res = await app.request("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plugins: ["test-plugin"] }),
		});
		expect(res.status).toBe(200);

		const body = (await json(res)) as { id: string; activePlugins: string[] };
		// Session must be persisted
		const session = await store.getSession(body.id);
		expect(session).not.toBeNull();
		expect(session!.activePlugins).toContain("test-plugin");
	});
});
