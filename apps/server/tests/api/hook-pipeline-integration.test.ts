/**
 * POST /api/actions — hook pipeline integration (audit 2026-04-21 finding F2).
 *
 * Before this pass `createHookPipeline()` was never wired into bootstrap, so
 * `PreStateCommit` hooks declared in plugin manifests only ran in unit tests.
 * This test feeds a hand-built hookPipeline through the same env the route
 * reads from and asserts that a PreStateCommit handler observes every
 * committed proposal and can abort to block the write.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import {
	createPluginRegistry,
	type PluginRegistry,
	type PluginRegistryEntry,
	type PluginSummary,
	type LoadedRuntime,
} from "@covel/plugin-loader";
import { createHookPipeline, type HookPipeline } from "@covel/runtime";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { makeFakeLLM, makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";

function makeSummary(overrides: Partial<PluginSummary> = {}): PluginSummary {
	return {
		id: "test-runtime",
		name: "Test Runtime",
		description: "",
		pluginType: "plugin",
		runtimeCount: 1,
		...overrides,
	};
}

function makeEntry(args: {
	id: string;
	loaded: LoadedRuntime;
}): PluginRegistryEntry {
	const parsed = {
		manifest: args.loaded.manifest,
		promptTemplate: args.loaded.promptTemplate,
		referenceLinks: [],
		rawFrontmatter: {},
	};
	return {
		id: args.id,
		summary: makeSummary({ id: args.id, name: args.id }),
		manifest: parsed,
		manifests: [parsed],
		loadedRuntimes: new Map([[args.loaded.manifest.name, args.loaded]]),
		status: "registered",
	} as PluginRegistryEntry;
}

async function drainActionStream(
	res: Response,
): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
	const out: Array<{ type: string; payload: Record<string, unknown> }> = [];
	if (!res.body) return out;
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			try {
				const env = JSON.parse(line.slice(6)) as {
					type?: string;
					payload?: Record<string, unknown>;
				};
				if (env.type) out.push({ type: env.type, payload: env.payload ?? {} });
			} catch {
				// ignore non-JSON lines
			}
		}
	}
	return out;
}

describe("POST /api/actions — hook pipeline wired through commit chain", () => {
	let store: DataStore;
	let registry: PluginRegistry;
	let app: Hono;
	let hookPipeline: HookPipeline;
	const sessionId = "sess-hooks";
	const RUNTIME_ID = "fake-narrator";
	const NARRATIVE = "A quiet market hums at dusk.";

	beforeEach(async () => {
		store = createMemoryStore();
		registry = createPluginRegistry();

		const loaded = makeFakeLoadedRuntime({
			name: RUNTIME_ID,
			pluginId: RUNTIME_ID,
			outputKind: "story",
		});
		registry.register(makeEntry({ id: RUNTIME_ID, loaded }));

		await store.createSession({
			id: sessionId,
			worldId: null,
			status: "active",
			presetId: null,
			activePlugins: [RUNTIME_ID],
			turnCount: 1,
			preGameCompleted: [],
			createdAt: new Date().toISOString(),
		});

		// Priority 500 runtimes need turnNumber >= 1 → seed a prior player message
		await store.appendTurnMessage({
			id: crypto.randomUUID(),
			sessionId,
			turnId: "pre-turn",
			sourceType: "player",
			role: "user",
			content: "opener",
			order: 0,
			createdAt: new Date().toISOString(),
		});

		hookPipeline = createHookPipeline();

		const { llm } = makeFakeLLM(NARRATIVE);
		const eventBus = createEventBus(store);
		const sessionLock = createInProcessSessionLock();

		app = new Hono();
		app.use("*", async (c, next) => {
			c.set("store", store);
			c.set("pluginRegistry", registry);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			c.set("llmAdapter", llm as any);
			c.set("loadRuntimeFn", async (m) =>
				m.name === RUNTIME_ID ? loaded : undefined,
			);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			c.set("toolExecutor", undefined as any);
			c.set("getConfigFn", () => ({}));
			c.set("resolveModel", () => undefined);
			c.set("eventBus", eventBus);
			c.set("hookPipeline", hookPipeline);
			c.set("sessionLock", sessionLock);
			await next();
		});
		app.route("/api/actions", actionRoutes);
	});

	it("invokes a PreStateCommit hook on every normalized proposal", async () => {
		const seen: Array<{ type: string; content?: string }> = [];
		hookPipeline.register({
			id: "test:PreStateCommit:0",
			event: "PreStateCommit",
			handler: async (_ctx, payload) => {
				const proposal = (
					payload as {
						proposal: { type: string; payload: Record<string, unknown> };
					}
				).proposal;
				seen.push({
					type: proposal.type,
					content: proposal.payload.content as string | undefined,
				});
				return { action: "continue" };
			},
		});

		const res = await app.request("/api/actions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: "req-hooks",
				type: "send_message",
				sessionId,
				payload: { content: "look around" },
			}),
		});
		expect(res.status).toBe(200);
		await drainActionStream(res);

		// At least one narrative.append proposal should have hit the hook.
		const narrativeHits = seen.filter((s) => s.type === "narrative.append");
		expect(narrativeHits.length).toBeGreaterThanOrEqual(1);
		expect(narrativeHits.some((s) => s.content?.includes(NARRATIVE))).toBe(
			true,
		);
	});

	it("aborts the commit when the hook returns { action: abort }", async () => {
		hookPipeline.register({
			id: "test:PreStateCommit:abort",
			event: "PreStateCommit",
			handler: async () => ({ action: "abort", reason: "test-blocked" }),
		});

		const res = await app.request("/api/actions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: "req-abort",
				type: "send_message",
				sessionId,
				payload: { content: "try again" },
			}),
		});
		expect(res.status).toBe(200);
		await drainActionStream(res);

		// The player message gets stored directly by the route, but the runtime
		// narrative is normalized into a proposal that runs through the commit
		// pipeline — the hook aborts, so no assistant message should land.
		const messages = await store.listMessages(sessionId);
		const assistantNarratives = messages.filter(
			(m) => m.role === "assistant" && m.content.includes(NARRATIVE),
		);
		expect(assistantNarratives).toHaveLength(0);
	});
});
