import { describe, it, expect } from "vitest";
import path from "node:path";
import {
	MockLLM,
	createTestHarness,
	expectAssetGenerated,
	makeTurnInput,
	makeTriggerContext,
	makeRuntimeResult,
} from "@covel/plugin-test-utils";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

// ── Factories ───────────────────────────────────────────────────

describe("makeTurnInput", () => {
	it("should create a TurnInput with defaults", () => {
		const input = makeTurnInput();
		expect(input.sessionId).toBeDefined();
		expect(input.turnId).toBeDefined();
		expect(input.playerMessage).toBeDefined();
	});

	it("should accept overrides", () => {
		const input = makeTurnInput({
			playerMessage: "我攻击龙",
			sessionId: "custom-session",
		});
		expect(input.playerMessage).toBe("我攻击龙");
		expect(input.sessionId).toBe("custom-session");
	});
});

describe("makeTriggerContext", () => {
	it("should create a TriggerContext with defaults", () => {
		const ctx = makeTriggerContext();
		expect(ctx.sessionId).toBeDefined();
		expect(ctx.turnNumber).toBe(1);
		expect(ctx.triggerCount).toBe(0);
	});

	it("should accept overrides", () => {
		const ctx = makeTriggerContext({ turnNumber: 5, triggerCount: 2 });
		expect(ctx.turnNumber).toBe(5);
		expect(ctx.triggerCount).toBe(2);
	});
});

describe("makeRuntimeResult", () => {
	it("should create a RuntimeResult with defaults", () => {
		const result = makeRuntimeResult();
		expect(result.status).toBe("success");
		expect(result.output).toEqual({});
		expect(result.toolCalls).toEqual([]);
	});

	it("should accept overrides", () => {
		const result = makeRuntimeResult({
			status: "failed",
			output: { foo: "bar" },
		});
		expect(result.status).toBe("failed");
		expect(result.output).toEqual({ foo: "bar" });
	});
});

// ── Contract assertions ────────────────────────────────────────

const MEDIA_REF = {
	id: "a".repeat(64),
	mime: "image/png",
	size: 123,
};

describe("expectAssetGenerated", () => {
	it("accepts output.assetGenerations[] with MediaRef payload", () => {
		const asset = expectAssetGenerated(
			makeRuntimeResult({
				output: {
					assetGenerations: [
						{ ref: MEDIA_REF, modality: "image", meta: { prompt: "mountain" } },
					],
				},
			}),
			{ modality: "image" },
		);

		expect(asset.ref).toEqual(MEDIA_REF);
		expect(asset.modality).toBe("image");
		expect(asset.meta).toEqual({ prompt: "mountain" });
	});

	it("accepts output.assetGenerations[] from a turn result", () => {
		const asset = expectAssetGenerated({
			turnId: "turn-1",
			sessionId: "sess-test",
			runtimeResults: [
				makeRuntimeResult({
					output: {
						assetGenerations: [{ ref: MEDIA_REF, modality: "image" }],
					},
				}),
			],
			durationMs: 10,
			timestamp: new Date().toISOString(),
		});

		expect(asset.modality).toBe("image");
	});

	it("fails when no asset was emitted", () => {
		expect(() => expectAssetGenerated(makeRuntimeResult())).toThrow(
			"Expected asset.generate output in output.assetGenerations[]",
		);
	});

	it("fails when the MediaRef shape is invalid", () => {
		expect(() =>
			expectAssetGenerated({
				assetGenerations: [{ ref: { id: "short" }, modality: "image" }],
			}),
		).toThrow("Expected asset.generate payload with MediaRef shape");
	});

	it("fails when expected modality is absent", () => {
		expect(() =>
			expectAssetGenerated(
				{ assetGenerations: [{ ref: MEDIA_REF, modality: "audio" }] },
				"image",
			),
		).toThrow('Expected asset.generate modality "image", received audio');
	});
});

// ── MockLLM ─────────────────────────────────────────────────────

describe("MockLLM", () => {
	it("should return default response", async () => {
		const llm = new MockLLM();
		const response = await llm.generate({
			messages: [{ role: "user", content: "hello" }],
		});
		expect(response.finishReason).toBe("stop");
		expect(response.toolCalls).toEqual([]);
	});

	it("should record all calls", async () => {
		const llm = new MockLLM();
		await llm.generate({ messages: [{ role: "user", content: "first" }] });
		await llm.generate({ messages: [{ role: "user", content: "second" }] });
		expect(llm.calls).toHaveLength(2);
		expect(llm.calls[0].messages[0].content).toBe("first");
	});

	it("should accept custom default response", async () => {
		const llm = new MockLLM({
			defaultResponse: {
				content: "你进入了黑暗的洞穴。",
				toolCalls: [],
				finishReason: "stop",
				usage: { inputTokens: 50, outputTokens: 30 },
			},
		});
		const response = await llm.generate({
			messages: [{ role: "user", content: "go" }],
		});
		expect(response.content).toBe("你进入了黑暗的洞穴。");
	});
});

// ── TestHarness ─────────────────────────────────────────────────

describe("createTestHarness", () => {
	it("should discover plugins and create a working harness", async () => {
		const harness = await createTestHarness({ pluginsDir: PLUGINS_DIR });
		expect(harness.manifests.length).toBeGreaterThan(0);
		expect(harness.store).toBeDefined();
		expect(harness.llm).toBeDefined();
	});

	it("should execute a turn and return results", async () => {
		const llm = new MockLLM({
			defaultResponse: {
				content: "你站在山脚下...",
				toolCalls: [],
				finishReason: "stop",
				usage: { inputTokens: 100, outputTokens: 50 },
			},
		});
		const harness = await createTestHarness({ pluginsDir: PLUGINS_DIR, llm });
		const result = await harness.executeTurn("开始游戏");

		expect(result.runtimeResults.length).toBeGreaterThan(0);
		expect(result.runtimeResults[0].status).toBe("success");
	});

	it("should use in-memory store", async () => {
		const harness = await createTestHarness({ pluginsDir: PLUGINS_DIR });
		// Store should be empty initially
		const sessions = await harness.store.listSessions("any-world");
		expect(sessions).toEqual([]);
	});
});
