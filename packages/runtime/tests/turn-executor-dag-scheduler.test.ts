/**
 * turn-executor DAG scheduler integration — verifies that the main-loop
 * band always uses the DAG scheduler (no feature flag) and that same-level
 * downstreams really run concurrently instead of being serialised by
 * priority number.
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

async function mainLoopStore(sessionId: string): Promise<DataStore> {
	const store = createMemoryStore();
	await store.appendTurnMessage({
		id: "seed",
		sessionId,
		turnId: "seed-turn",
		sourceType: "player",
		role: "user",
		content: "prior",
		order: 0,
		createdAt: "2024-01-01T00:00:00Z",
	});
	return store;
}

function manifest(
	name: string,
	priority: number,
	overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
	return {
		name,
		pluginId: name.split("/")[0]!,
		description: name,
		priority,
		runtimeType: "function",
		handler: "./h.js",
		trigger: { type: "auto" },
		...overrides,
	} as RuntimeManifest;
}

describe("executeTurn main-loop DAG scheduler", () => {
	it("runs independent narrator downstreams concurrently", async () => {
		// narrator, then guide + codex + char-tracker in parallel (all depend only
		// on narrator). Without the DAG scheduler they would execute strictly in
		// priority order — this test forces them to overlap by making each handler
		// take ≥ 40ms and asserting the wall-clock time of the downstream level is
		// less than 3× the per-runtime delay.
		const narrator = manifest("narrator", 500);
		const guide = manifest("guide", 550, {
			input: {
				inject: [
					{
						kind: "runtime",
						from: "narrator",
						field: "narrativeOutput",
						as: "<n>",
					},
				],
			},
		} as Partial<RuntimeManifest>);
		const extractor = manifest("npc-graph/extractor", 620, {
			input: {
				inject: [
					{
						kind: "runtime",
						from: "narrator",
						field: "narrativeOutput",
						as: "<n>",
					},
				],
			},
		} as Partial<RuntimeManifest>);
		const codex = manifest("codex", 650, {
			input: {
				inject: [
					{
						kind: "runtime",
						from: "narrator",
						field: "narrativeOutput",
						as: "<n>",
					},
				],
			},
		} as Partial<RuntimeManifest>);
		const charTracker = manifest("char-creator/character-tracker", 750, {
			input: {
				inject: [
					{
						kind: "runtime",
						from: "narrator",
						field: "narrativeOutput",
						as: "<n>",
					},
				],
			},
		} as Partial<RuntimeManifest>);

		const DELAY = 60;
		const timings: Record<string, { start: number; end: number }> = {};

		const makeHandler = (name: string) => async () => {
			const start = Date.now();
			await new Promise((r) => setTimeout(r, DELAY));
			timings[name] = { start, end: Date.now() };
			return { narrativeOutput: "x" };
		};

		const input: TurnInput = {
			sessionId: "sess-dag",
			turnId: "turn-1",
			playerMessage: "go",
		};
		const deps: TurnExecutorDeps = {
			loadRuntime: async (m) => ({
				manifest: m,
				promptTemplate: "",
				references: [],
				handler: makeHandler(m.name),
			}),
			llm: new NoopLLM(),
			getConfig: () => ({}),
			store: await mainLoopStore("sess-dag"),
		};

		const result = await executeTurn(
			input,
			[narrator, guide, extractor, codex, charTracker],
			deps,
		);

		// All runtimes must have completed.
		expect(result.runtimeResults.every((r) => r.status === "success")).toBe(
			true,
		);

		// Narrator finished before any downstream started.
		const nEnd = timings["narrator"].end;
		const downstreams = [
			"guide",
			"npc-graph/extractor",
			"codex",
			"char-creator/character-tracker",
		];
		for (const d of downstreams) {
			expect(timings[d].start).toBeGreaterThanOrEqual(nEnd);
		}

		// Downstream runtimes overlap in time — the max end minus the min start
		// should be noticeably less than 4 * DELAY if they ran in parallel.
		const dsStarts = downstreams.map((d) => timings[d].start);
		const dsEnds = downstreams.map((d) => timings[d].end);
		const wall = Math.max(...dsEnds) - Math.min(...dsStarts);
		// Allow plenty of slack for CI flakiness, but strictly less than serial
		// execution (which would be ~4 * DELAY = 240ms).
		expect(wall).toBeLessThan(DELAY * 3);
	});
});
