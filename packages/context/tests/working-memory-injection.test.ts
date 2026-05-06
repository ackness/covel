/**
 * Working Memory context injection tests (S3-T3).
 *
 * Verifies that:
 * - V1 path: systemPrompt contains [Working Memory] block with correct ordering
 * - V2 path: segment 2 is populated
 * - Flag-off: no [Working Memory] block emitted
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildContext } from "../src/context-builder.js";
import type { ContextBuildParams } from "../src/types.js";
import type { RuntimeManifest } from "@covel/shared";

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
	// Default to promptVersion: 2 so V2-path tests route through buildContextV2
	// under the new S2-T4 double-gate (env flag + manifest opt-in).
	return {
		name: "test-runtime",
		pluginId: "test-plugin",
		pluginType: "plugin",
		description: "test",
		version: "0.0.1",
		runtimeType: "agent",
		trigger: { mode: "always" },
		tools: { builtin: [], local: [] },
		priority: 500,
		promptVersion: 2,
		...overrides,
	};
}

function makeParams(
	overrides?: Partial<ContextBuildParams>,
): ContextBuildParams {
	return {
		promptTemplate: "You are a narrator.",
		manifest: makeManifest(),
		turnInput: {
			sessionId: "sess-ctx",
			turnId: "turn-ctx",
			playerMessage: "Test",
			locale: undefined,
		},
		completedResults: new Map(),
		config: {},
		...overrides,
	};
}

describe("Working Memory context injection (V1 path)", () => {
	let originalWmFlag: string | undefined;
	let originalV2Flag: string | undefined;

	beforeEach(() => {
		originalWmFlag = process.env.COVEL_WORKING_MEMORY_V1;
		originalV2Flag = process.env.COVEL_PROMPT_V2;
		delete process.env.COVEL_PROMPT_V2; // force V1 path
	});

	afterEach(() => {
		if (originalWmFlag === undefined) {
			delete process.env.COVEL_WORKING_MEMORY_V1;
		} else {
			process.env.COVEL_WORKING_MEMORY_V1 = originalWmFlag;
		}
		if (originalV2Flag === undefined) {
			delete process.env.COVEL_PROMPT_V2;
		} else {
			process.env.COVEL_PROMPT_V2 = originalV2Flag;
		}
	});

	it("flag ON + entries present: systemPrompt contains [Working Memory] block", () => {
		process.env.COVEL_WORKING_MEMORY_V1 = "1";

		const params = makeParams({
			workingMemory: [
				{ scope: "player", key: "prefs", value: { theme: "dark" } },
				{ scope: "story", key: "flags", value: ["started"] },
			],
		});

		const ctx = buildContext(params);
		expect(ctx.systemPrompt).toContain("[Working Memory]");
		expect(ctx.systemPrompt).toContain("player.prefs:");
		expect(ctx.systemPrompt).toContain("story.flags:");
	});

	it("flag ON: entries sorted player → story → shared, alphabetical key", () => {
		process.env.COVEL_WORKING_MEMORY_V1 = "1";

		const params = makeParams({
			workingMemory: [
				{ scope: "shared", key: "goal", value: "find artifact" },
				{ scope: "player", key: "prefs", value: {} },
				{ scope: "story", key: "flags", value: [] },
				{ scope: "player", key: "avatar", value: "hero" },
			],
		});

		const ctx = buildContext(params);
		const wmBlock =
			ctx.systemPrompt
				.split("\n\n")
				.find((seg) => seg.includes("[Working Memory]")) ?? "";
		const playerAvatarPos = wmBlock.indexOf("player.avatar:");
		const playerPrefsPos = wmBlock.indexOf("player.prefs:");
		const storyFlagsPos = wmBlock.indexOf("story.flags:");
		const sharedGoalPos = wmBlock.indexOf("shared.goal:");

		// player comes before story, story before shared
		expect(playerAvatarPos).toBeLessThan(storyFlagsPos);
		expect(playerPrefsPos).toBeLessThan(storyFlagsPos);
		expect(storyFlagsPos).toBeLessThan(sharedGoalPos);
		// alphabetical within player scope
		expect(playerAvatarPos).toBeLessThan(playerPrefsPos);
	});

	it("flag ON + no entries: no [Working Memory] block rendered", () => {
		process.env.COVEL_WORKING_MEMORY_V1 = "1";

		const params = makeParams({ workingMemory: [] });
		const ctx = buildContext(params);
		expect(ctx.systemPrompt).not.toContain("[Working Memory]");
	});

	it("flag ON + workingMemory undefined: no [Working Memory] block rendered", () => {
		process.env.COVEL_WORKING_MEMORY_V1 = "1";

		const params = makeParams({ workingMemory: undefined });
		const ctx = buildContext(params);
		expect(ctx.systemPrompt).not.toContain("[Working Memory]");
	});

	it("flag OFF: [Working Memory] block NOT rendered even when entries provided", () => {
		delete process.env.COVEL_WORKING_MEMORY_V1;

		const params = makeParams({
			workingMemory: [{ scope: "player", key: "k", value: "v" }],
		});
		const ctx = buildContext(params);
		expect(ctx.systemPrompt).not.toContain("[Working Memory]");
	});
});

describe("Working Memory context injection (V2 path)", () => {
	let originalWmFlag: string | undefined;
	let originalV2Flag: string | undefined;

	beforeEach(() => {
		originalWmFlag = process.env.COVEL_WORKING_MEMORY_V1;
		originalV2Flag = process.env.COVEL_PROMPT_V2;
		process.env.COVEL_PROMPT_V2 = "1"; // force V2 path
	});

	afterEach(() => {
		if (originalWmFlag === undefined) {
			delete process.env.COVEL_WORKING_MEMORY_V1;
		} else {
			process.env.COVEL_WORKING_MEMORY_V1 = originalWmFlag;
		}
		if (originalV2Flag === undefined) {
			delete process.env.COVEL_PROMPT_V2;
		} else {
			process.env.COVEL_PROMPT_V2 = originalV2Flag;
		}
	});

	it("V2 flag ON + WM flag ON + entries: systemPrompt contains [Working Memory]", () => {
		process.env.COVEL_WORKING_MEMORY_V1 = "1";

		const params = makeParams({
			workingMemory: [{ scope: "player", key: "persona", value: "warrior" }],
		});

		const ctx = buildContext(params);
		expect(ctx.systemPrompt).toContain("[Working Memory]");
		expect(ctx.systemPrompt).toContain("player.persona:");
		expect(ctx.systemPrompt).toContain('"warrior"');
	});

	it("V2 flag ON + WM flag OFF: no [Working Memory] block", () => {
		delete process.env.COVEL_WORKING_MEMORY_V1;

		const params = makeParams({
			workingMemory: [{ scope: "story", key: "k", value: 1 }],
		});
		const ctx = buildContext(params);
		expect(ctx.systemPrompt).not.toContain("[Working Memory]");
	});

	it("V2 path: WM segment appears before plugin instructions", () => {
		process.env.COVEL_WORKING_MEMORY_V1 = "1";

		const params = makeParams({
			promptTemplate: "You are a narrator.",
			workingMemory: [{ scope: "player", key: "k", value: 1 }],
		});

		const ctx = buildContext(params);
		const wmPos = ctx.systemPrompt.indexOf("[Working Memory]");
		const pluginPos = ctx.systemPrompt.indexOf("You are a narrator.");
		expect(wmPos).toBeGreaterThanOrEqual(0);
		expect(wmPos).toBeLessThan(pluginPos);
	});
});
