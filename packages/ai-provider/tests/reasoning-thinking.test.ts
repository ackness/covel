/**
 * Regression tests for thinking-mode support:
 *
 *  1. `reasoning_content` must round-trip across multi-turn calls so
 *     providers that enforce it (DashScope Qwen, DeepSeek v4 thinking)
 *     do not return HTTP 400 on the follow-up request.
 *  2. Slot-level TOML fields `thinking`, `reasoning_effort`, and
 *     `providerRequestMetadata` must be forwarded to the adapter body.
 *  3. Per-call `providerRequestMetadata` must override slot defaults.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { parseLlmConfig } from "../src/config/llm-loader.js";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import type { ModelProfile, PresetConfig } from "../src/types.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";

// ── Helpers ────────────────────────────────────────────────────────

interface CapturedRequest {
	url: string;
	init: RequestInit;
	body: unknown;
}

function mockOpenAiChatResponse(
	body: Record<string, unknown>,
): CapturedRequest[] {
	const captured: CapturedRequest[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, init?: RequestInit) => {
			const raw = typeof init?.body === "string" ? init.body : "";
			const parsed = raw.length > 0 ? JSON.parse(raw) : {};
			captured.push({ url, init: init ?? {}, body: parsed });
			return Promise.resolve({
				ok: true,
				status: 200,
				headers: new Headers({ "content-type": "application/json" }),
				text: () => Promise.resolve(JSON.stringify(body)),
				json: () => Promise.resolve(body),
			} as unknown as Response);
		}),
	);
	return captured;
}

function ssePayload(events: Array<Record<string, unknown>>): ReadableStream {
	const encoder = new TextEncoder();
	const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(lines + "data: [DONE]\n\n"));
			controller.close();
		},
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ── 1. reasoning_content round-trip ────────────────────────────────

describe("openai-chat adapter — reasoning_content", () => {
	it("reads `choices[0].message.reasoning_content` on non-streaming generateText", async () => {
		mockOpenAiChatResponse({
			choices: [
				{
					message: {
						role: "assistant",
						content: "final answer",
						reasoning_content: "let me think step by step ...",
					},
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		});

		const adapter = createOpenAiChatAdapter();
		const result = await adapter.generateText(
			{ baseUrl: "https://api.deepseek.com", apiKey: "k" },
			{
				model: "deepseek-v4-flash",
				messages: [{ role: "user", content: "hi" }],
			},
			{ profile: {} as never, preset: null, mode: "text" },
		);

		expect(result.text).toBe("final answer");
		expect(result.reasoningContent).toBe("let me think step by step ...");
	});

	it("serializes assistant.reasoningContent back to the wire as `reasoning_content`", async () => {
		const captured = mockOpenAiChatResponse({
			choices: [
				{
					message: { role: "assistant", content: "ok" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		});

		const adapter = createOpenAiChatAdapter();
		await adapter.generateText(
			{ baseUrl: "https://api.deepseek.com", apiKey: "k" },
			{
				model: "deepseek-v4-flash",
				messages: [
					{ role: "user", content: "hi" },
					{
						role: "assistant",
						content: "prev answer",
						reasoningContent: "prior chain of thought",
						toolCalls: [{ id: "call_1", name: "noop", arguments: "{}" }],
					},
					{ role: "tool", content: "{}", toolCallId: "call_1" },
				],
			},
			{ profile: {} as never, preset: null, mode: "text" },
		);

		const body = captured[0]?.body as {
			messages: Array<Record<string, unknown>>;
		};
		const assistantMsg = body.messages.find((m) => m.role === "assistant");
		expect(assistantMsg?.reasoning_content).toBe("prior chain of thought");
		expect(
			Array.isArray((assistantMsg as { tool_calls?: unknown[] }).tool_calls),
		).toBe(true);
	});

	it("accumulates stream reasoning deltas and emits them on `done`", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				headers: new Headers({ "content-type": "text/event-stream" }),
				body: ssePayload([
					{ choices: [{ delta: { reasoning_content: "thinking " } }] },
					{ choices: [{ delta: { reasoning_content: "hard..." } }] },
					{ choices: [{ delta: { content: "answer" } }] },
					{ choices: [{ finish_reason: "stop" }] },
				]),
			}),
		);

		const adapter = createOpenAiChatAdapter();
		const events = [];
		for await (const ev of adapter.streamText(
			{ baseUrl: "https://api.deepseek.com", apiKey: "k" },
			{
				model: "deepseek-v4-flash",
				messages: [{ role: "user", content: "hi" }],
			},
			{ profile: {} as never, preset: null, mode: "stream" },
		)) {
			events.push(ev);
		}

		const done = events.find((e) => e.type === "done");
		expect(done).toBeDefined();
		expect((done as { reasoningContent?: string }).reasoningContent).toBe(
			"thinking hard...",
		);
	});
});

// ── 2. thinking / reasoning_effort schema wiring ───────────────────

describe("llm-loader — thinking-mode controls", () => {
	it("promotes `thinking`, `reasoning_effort`, and `providerRequestMetadata` onto the preset", () => {
		const toml = `
[covel.story]
provider = "deepseek"
model = "deepseek-v4-flash"
baseUrl = "https://api.deepseek.com"
protocol = "openai-chat-v1"
reasoning_effort = "high"

[covel.story.thinking]
type = "enabled"

[covel.story.providerRequestMetadata]
enable_thinking = true
`;
		const { aiConfig } = parseLlmConfig(toml);
		const preset = aiConfig.presets.find((p) => p.id === "slot-story");
		expect(preset?.providerRequestMetadata).toEqual({
			enable_thinking: true,
			thinking: { type: "enabled" },
			reasoning_effort: "high",
		});
	});

	it("leaves providerRequestMetadata undefined when no thinking fields are set", () => {
		const toml = `
[covel.story]
provider = "deepseek"
model = "deepseek-v4-flash"
baseUrl = "https://api.deepseek.com"
protocol = "openai-chat-v1"
`;
		const { aiConfig } = parseLlmConfig(toml);
		const preset = aiConfig.presets.find((p) => p.id === "slot-story");
		expect(preset?.providerRequestMetadata).toBeUndefined();
	});
});

// ── 3. Gateway merges preset.providerRequestMetadata into calls ────

describe("gateway — preset providerRequestMetadata fold-in", () => {
	it("includes slot-wide thinking/reasoning_effort on the outgoing call", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const adapter: ModelProviderAdapter = {
			async generateText(_config, params) {
				captured.push(params.providerRequestMetadata ?? {});
				return {
					text: "ok",
					finishReason: "stop",
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			},
			async generateObject() {
				throw new Error("not called");
			},
			async *streamText() {
				yield {
					type: "done" as const,
					finishReason: "stop",
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			},
			async embed() {
				return { embeddings: [], usage: null };
			},
			async generateImage() {
				return { images: [], usage: null };
			},
			async synthesizeSpeech() {
				return {
					audio: { mimeType: "audio/mp3", data: new Uint8Array() },
					usage: null,
				};
			},
			async transcribeAudio() {
				return { text: "", usage: null };
			},
		};

		const profile: ModelProfile = {
			id: "embed-default",
			tier: "embed-default",
			provider: "p",
			model: "m",
			contextWindow: 1,
			latencyClass: "medium",
			costClass: "medium",
			supportedModes: ["text"],
		};
		const preset: PresetConfig = {
			id: "slot-story",
			name: "Story",
			provider: "p",
			protocol: "openai-chat-v1",
			model: "deepseek-v4-flash",
			baseUrl: "https://api.deepseek.com",
			tier: "medium",
			supportedModes: ["text", "object", "stream"],
			enabled: true,
			isDefault: true,
			tag: "text",
			providerRequestMetadata: {
				thinking: { type: "enabled" },
				reasoning_effort: "high",
			},
		};

		const providerRegistry2 = createProviderRegistry({
			providers: {
				p: {
					adapter,
					defaults: { baseUrl: preset.baseUrl!, apiKey: "test" },
				},
			},
		});
		const presetRegistry = createPresetRegistry({
			profiles: [profile],
			presets: [preset],
		});

		const gateway = createGateway({
			providerRegistry: providerRegistry2,
			presetRegistry,
		});
		await gateway.generateText({
			presetId: "slot-story",
			messages: [{ role: "user", content: "hi" }],
		});

		expect(captured[0]).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "high",
		});
	});

	it("lets per-call metadata override slot defaults", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const adapter: ModelProviderAdapter = {
			async generateText(_config, params) {
				captured.push(params.providerRequestMetadata ?? {});
				return {
					text: "ok",
					finishReason: "stop",
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			},
			async generateObject() {
				throw new Error("not called");
			},
			async *streamText() {
				yield {
					type: "done" as const,
					finishReason: "stop",
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			},
			async embed() {
				return { embeddings: [], usage: null };
			},
			async generateImage() {
				return { images: [], usage: null };
			},
			async synthesizeSpeech() {
				return {
					audio: { mimeType: "audio/mp3", data: new Uint8Array() },
					usage: null,
				};
			},
			async transcribeAudio() {
				return { text: "", usage: null };
			},
		};

		const profile: ModelProfile = {
			id: "embed-default",
			tier: "embed-default",
			provider: "p",
			model: "m",
			contextWindow: 1,
			latencyClass: "medium",
			costClass: "medium",
			supportedModes: ["text"],
		};
		const preset: PresetConfig = {
			id: "slot-story",
			name: "Story",
			provider: "p",
			protocol: "openai-chat-v1",
			model: "m",
			baseUrl: "https://x",
			tier: "medium",
			supportedModes: ["text", "object", "stream"],
			enabled: true,
			isDefault: true,
			tag: "text",
			providerRequestMetadata: { reasoning_effort: "high" },
		};

		const providerRegistry = createProviderRegistry({
			providers: {
				p: {
					adapter,
					defaults: { baseUrl: "https://x", apiKey: "test" },
				},
			},
		});
		const presetRegistry = createPresetRegistry({
			profiles: [profile],
			presets: [preset],
		});

		const gateway = createGateway({ providerRegistry, presetRegistry });
		await gateway.generateText({
			presetId: "slot-story",
			messages: [{ role: "user", content: "hi" }],
			providerRequestMetadata: { reasoning_effort: "low" },
		});

		expect(captured[0]?.reasoning_effort).toBe("low");
	});
});
