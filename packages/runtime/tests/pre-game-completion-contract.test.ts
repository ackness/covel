/**
 * Pre-Game completion contract — locks the three signals that can mark a
 * Pre-Game runtime as done: `preGameDone: true`, guard-skipped, and
 * maxTriggerCount exhaustion. Also verifies `turnCount` only advances
 * to 1 when *all* Pre-Game runtimes in the active set are accounted for.
 *
 * This is subtle enough that drift here silently breaks opening flows
 * (player stuck on character form, main-loop never starts), so we pin
 * the behaviour with a dedicated test file.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm-adapter.js";

class NoopLLM implements LLMAdapter {
	async generate(): Promise<LLMResponse> {
		return {
			content: "{}",
			toolCalls: [],
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1 },
		};
	}
}

function pregameManifest(
	name: string,
	overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
	return {
		name,
		pluginId: name.split("/")[0]!,
		description: name,
		priority: 50, // Pre-Game band
		runtimeType: "function",
		handler: "./h.js",
		trigger: { type: "scheduled", interval: 1 },
		...overrides,
	} as RuntimeManifest;
}

async function freshStore(
	sessionId: string,
	worldId = "w1",
): Promise<DataStore> {
	const store = createMemoryStore();
	await store.createSession({
		id: sessionId,
		worldId,
		turnCount: 0,
		status: "active",
		activePlugins: [],
		preGameCompleted: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	return store;
}

async function runPregameTurn(
	sessionId: string,
	manifests: readonly RuntimeManifest[],
	handlers: Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>,
	options?: {
		guards?: Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
	},
): Promise<{
	store: DataStore;
	result: Awaited<ReturnType<typeof executeTurn>>;
}> {
	const store = await freshStore(sessionId);
	const input: TurnInput = { sessionId, turnId: "turn-0", playerMessage: "" };
	const deps: TurnExecutorDeps = {
		loadRuntime: async (m) => ({
			manifest: m,
			promptTemplate: "",
			references: [],
			handler: handlers[m.name],
			guard: options?.guards?.[m.name],
		}),
		llm: new NoopLLM(),
		getConfig: () => ({}),
		store,
	};
	const result = await executeTurn(input, manifests, deps);
	return { store, result };
}

describe("Pre-Game completion contract", () => {
	it("marks a runtime done when output.preGameDone === true", async () => {
		const m = pregameManifest("pregame", { priority: 10 });
		const { store } = await runPregameTurn("sess-done", [m], {
			pregame: async () => ({
				narrativeOutput: "welcome",
				preGameDone: true,
			}),
		});

		const session = await store.getSession("sess-done");
		expect(session?.preGameCompleted).toEqual(["pregame"]);
		// Only Pre-Game runtime present, so everyone's done → advance to turn 1.
		expect(session?.turnCount).toBe(1);
	});

	it("marks an AGENT runtime done when its guard returns skip:true", async () => {
		// Guard is only consulted on the agent-runtime code path (function
		// runtimes use a plain handler). schema-gen is agent by default.
		const m = pregameManifest("world-init/schema-gen", {
			priority: 85,
			runtimeType: "agent",
		});
		const { store } = await runPregameTurn(
			"sess-guard",
			[m],
			{}, // no handler — guard must short-circuit before execution.
			{
				guards: {
					"world-init/schema-gen": async () => ({
						skip: true,
						reason: "already-initialised",
					}),
				},
			},
		);

		const session = await store.getSession("sess-guard");
		expect(session?.preGameCompleted).toEqual(["world-init/schema-gen"]);
		expect(session?.turnCount).toBe(1);
	});

	it("does NOT advance turnCount when any Pre-Game runtime is unfinished", async () => {
		const pregame = pregameManifest("pregame", { priority: 10 });
		// player-init simulates "form shown, waiting for submission": handler
		// returns without preGameDone so the framework keeps it open across turns.
		const playerInit = pregameManifest("char-creator/player-init", {
			priority: 50,
		});

		const { store } = await runPregameTurn("sess-open", [pregame, playerInit], {
			pregame: async () => ({ preGameDone: true }),
			"char-creator/player-init": async () => ({
				ui: [{ type: "form", interactionId: "char" }],
				// preGameDone intentionally absent — form not yet submitted.
			}),
		});

		const session = await store.getSession("sess-open");
		// Pregame recorded; player-init NOT recorded.
		expect(session?.preGameCompleted).toEqual(["pregame"]);
		// Pre-Game still in progress → turnCount stays at 0.
		expect(session?.turnCount).toBe(0);
	});

	it("keeps bootstrap outside player history while setup is unfinished", async () => {
		const pregame = pregameManifest("pregame", { priority: 10 });
		const playerInit = pregameManifest("char-creator/player-init", {
			priority: 50,
		});
		const store = await freshStore("sess-bootstrap");
		const input = {
			sessionId: "sess-bootstrap",
			turnId: "turn-0",
			playerMessage: "",
			suppressPlayerMessage: true,
		};
		const deps: TurnExecutorDeps = {
			loadRuntime: async (m) => ({
				manifest: m,
				promptTemplate: "",
				references: [],
				handler: async () =>
					m.name === "pregame"
						? { preGameDone: true }
						: { form: { formId: "character-form" } },
			}),
			llm: new NoopLLM(),
			getConfig: () => ({}),
			store,
		};

		await executeTurn(input, [pregame, playerInit], deps);

		const playerMessages = (
			await store.listTurnMessages("sess-bootstrap")
		).filter((msg) => msg.sourceType === "player");
		const session = await store.getSession("sess-bootstrap");
		expect(playerMessages).toHaveLength(0);
		expect(session?.preGameCompleted).toEqual(["pregame"]);
		expect(session?.turnCount).toBe(0);
	});

	it("continues pending setup scheduling after player history exists", async () => {
		const pregame = pregameManifest("pregame", { priority: 10 });
		const playerInit = pregameManifest("char-creator/player-init", {
			priority: 50,
		});
		const narrator = pregameManifest("narrator", { priority: 500 });
		const store = await freshStore("sess-resume");
		await store.updateSession("sess-resume", {
			preGameCompleted: ["pregame"],
			updatedAt: new Date().toISOString(),
		});
		await store.appendTurnMessage({
			id: "prior-player",
			sessionId: "sess-resume",
			turnId: "prior-turn",
			sourceType: "player",
			role: "user",
			content: "saved form values",
			order: 0,
			createdAt: new Date().toISOString(),
		});

		const deps: TurnExecutorDeps = {
			loadRuntime: async (m) => ({
				manifest: m,
				promptTemplate: "",
				references: [],
				handler: async () => {
					if (m.name === "narrator") {
						return { narrativeOutput: "main loop started" };
					}
					return { preGameDone: true };
				},
			}),
			llm: new NoopLLM(),
			getConfig: () => ({}),
			store,
		};

		const result = await executeTurn(
			{
				sessionId: "sess-resume",
				turnId: "turn-1",
				playerMessage: "continue setup",
			},
			[pregame, playerInit, narrator],
			deps,
		);

		const session = await store.getSession("sess-resume");
		expect(result.runtimeResults.map((r) => r.runtimeId)).toEqual([
			"char-creator/player-init",
			"narrator",
		]);
		expect(session?.preGameCompleted?.slice().sort()).toEqual(
			["pregame", "char-creator/player-init"].sort(),
		);
		expect(session?.turnCount).toBe(1);
	});

	it("does not mark framework upstream skips as Pre-Game completion", async () => {
		const playerInit = pregameManifest("char-creator/player-init", {
			priority: 50,
			upstreamRequired: ["pregame"],
		});

		const { store, result } = await runPregameTurn(
			"sess-upstream-skip",
			[playerInit],
			{
				"char-creator/player-init": async () => ({ preGameDone: true }),
			},
		);

		expect(result.runtimeResults[0]?.status).toBe("skipped");
		expect(result.runtimeResults[0]?.output).toMatchObject({
			skippedBy: "framework:upstreamRequired",
		});
		const session = await store.getSession("sess-upstream-skip");
		expect(session?.preGameCompleted).toEqual([]);
		expect(session?.turnCount).toBe(0);
	});

	it("advances turnCount when EVERY Pre-Game runtime reports done in the same turn", async () => {
		// When both plugins complete in turn 0 (e.g. pregame completes on first
		// hit, schema-gen guard skips because schema already exists), the kernel
		// must atomically record both in preGameCompleted AND bump turnCount to 1.
		const pregame = pregameManifest("pregame", { priority: 10 });
		const playerInit = pregameManifest("char-creator/player-init", {
			priority: 50,
		});

		const { store } = await runPregameTurn("sess-both", [pregame, playerInit], {
			pregame: async () => ({ preGameDone: true }),
			"char-creator/player-init": async () => ({ preGameDone: true }),
		});

		const session = await store.getSession("sess-both");
		expect(session?.preGameCompleted?.slice().sort()).toEqual(
			["char-creator/player-init", "pregame"].sort(),
		);
		expect(session?.turnCount).toBe(1);
	});

	it("treats maxTriggerCount-exhausted runtimes as done (does not block advancement)", async () => {
		// A runtime that already hit its trigger budget in a previous turn must
		// not hold up Pre-Game forever. In practice `pregame` has
		// `maxTriggerCount: 1`; after its first turn the kernel should accept
		// exhaustion as "done".
		const pregame = pregameManifest("pregame", {
			priority: 10,
			trigger: { type: "scheduled", interval: 1, maxTriggerCount: 1 },
		});

		const store = await freshStore("sess-exh");
		// Seed one prior runtime-sourced TurnMessage to set triggerCount >= 1 and
		// simulate the runtime having already run last turn.
		await store.appendTurnMessage({
			id: "prior",
			sessionId: "sess-exh",
			turnId: "turn--1",
			sourceType: "runtime",
			sourcePluginId: "pregame",
			sourceRuntimeId: "pregame",
			role: "assistant",
			content: "prior pregame output",
			order: 10,
			createdAt: new Date().toISOString(),
		});

		const deps: TurnExecutorDeps = {
			loadRuntime: async (m) => ({
				manifest: m,
				promptTemplate: "",
				references: [],
				handler: async () => {
					throw new Error("exhausted runtime must not be invoked");
				},
			}),
			llm: new NoopLLM(),
			getConfig: () => ({}),
			store,
		};
		await executeTurn(
			{ sessionId: "sess-exh", turnId: "turn-0", playerMessage: "" },
			[pregame],
			deps,
		);

		const session = await store.getSession("sess-exh");
		expect(session?.preGameCompleted).toEqual(["pregame"]);
		expect(session?.turnCount).toBe(1);
	});
});
