/**
 * S2-T3 replay test — Anthropic `cache_control` injection.
 *
 * Mocks `globalThis.fetch` and asserts that when the Anthropic adapter
 * receives a ProviderConfig with `cacheStrategy: 'anthropic-explicit'`
 * and a system prompt containing `PROMPT_CACHE_BREAKPOINT_MARKER`
 * sentinels, the outgoing request body:
 *
 *   1. Uses an array `system` field (not a plain string)
 *   2. Places a `cache_control: { type: 'ephemeral' }` hint on every
 *      segment that preceded a sentinel
 *   3. Never emits more than ANTHROPIC_MAX_CACHE_BREAKPOINTS (4) hints
 *   4. Leaves the trailing open segment uncached
 *
 * It also pins the flag-off regression path: when `cacheStrategy` is
 * absent / `"none"` / no sentinel is present, the body reverts to the
 * pre-S2-T3 plain-string `system` field.
 *
 * No real network calls, no snapshots — exact shape assertions.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PROMPT_CACHE_BREAKPOINT_MARKER,
	stripPromptCacheMarkers,
} from "@covel/shared";
import { createAnthropicMessagesAdapter } from "../../src/adapters/anthropic-messages.js";
import type { ProviderConfig, TextMessage } from "../../src/types.js";

// ── Fixture helpers ─────────────────────────────────────────────────

/** Build a fake Anthropic JSON response for generateText. */
function makeTextResponse(): Response {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: new Headers(),
		async text() {
			return JSON.stringify({
				content: [{ type: "text", text: "ok" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 5, output_tokens: 3 },
			});
		},
		async json() {
			return {
				content: [{ type: "text", text: "ok" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 5, output_tokens: 3 },
			};
		},
	} as unknown as Response;
}

/** Extract the JSON body posted by the mocked fetch call. */
function readPostedBody(): Record<string, unknown> {
	const calls = vi.mocked(fetch).mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	const init = calls[0]![1] as RequestInit | undefined;
	expect(init).toBeDefined();
	expect(typeof init!.body).toBe("string");
	return JSON.parse(init!.body as string) as Record<string, unknown>;
}

/** Build a system+user message pair — the "system" string carries sentinels. */
function makeMessagesWithCacheMarkers(): TextMessage[] {
	const SENT = PROMPT_CACHE_BREAKPOINT_MARKER;
	const systemPrompt =
		`[LANGUAGE] Respond in English.${SENT}` +
		`\n\n` +
		`You are a test narrator. Follow the instructions carefully.${SENT}` +
		`\n\n` +
		`<lorebook>entry: dragons breathe fire.</lorebook>${SENT}`;
	return [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: "What happens next?" },
	];
}

/** Build a system+user message pair with NO sentinels. */
function makeMessagesWithoutCacheMarkers(): TextMessage[] {
	return [
		{ role: "system", content: "You are a test narrator." },
		{ role: "user", content: "Hi" },
	];
}

const ANTHROPIC_CONFIG_BASE: ProviderConfig = {
	baseUrl: "https://api.anthropic.com/v1",
	apiKey: "test-key",
};

// ── Tests ───────────────────────────────────────────────────────────

describe("Anthropic adapter — cache_control injection (S2-T3)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	describe("cacheStrategy: 'anthropic-explicit' + sentinel present", () => {
		it("emits an array `system` field with cache_control on each sentinel-preceded segment", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeTextResponse()));

			const adapter = createAnthropicMessagesAdapter();
			await adapter.generateText(
				{ ...ANTHROPIC_CONFIG_BASE, cacheStrategy: "anthropic-explicit" },
				{
					model: "claude-3-haiku-20240307",
					messages: makeMessagesWithCacheMarkers(),
				},
				{ profile: {} as never, preset: undefined, mode: "text" },
			);

			const body = readPostedBody();
			const systemField = body.system;

			expect(Array.isArray(systemField)).toBe(true);
			const blocks = systemField as Array<Record<string, unknown>>;
			// 3 sentinels → 3 non-empty cacheable segments. Trailing empty split
			// element is dropped by the builder, so blocks.length === 3.
			expect(blocks.length).toBe(3);

			for (const block of blocks) {
				expect(block.type).toBe("text");
				expect(typeof block.text).toBe("string");
				// No sentinel characters survive into wire text.
				expect(block.text as string).not.toContain(
					PROMPT_CACHE_BREAKPOINT_MARKER,
				);
			}

			// All three segments sat BEFORE a sentinel → all three are cacheable.
			const cacheHints = blocks
				.map((b) => b.cache_control as Record<string, unknown> | undefined)
				.filter(Boolean);
			expect(cacheHints.length).toBe(3);
			for (const hint of cacheHints) {
				expect(hint).toEqual({ type: "ephemeral" });
			}
		});

		it("never emits more than 4 cache_control hints (Anthropic API limit)", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeTextResponse()));

			// Craft 6 sentinel-delimited segments. The adapter must clamp to 4
			// cacheable breakpoints even if the assembler someday emits more.
			const SENT = PROMPT_CACHE_BREAKPOINT_MARKER;
			const oversized = `seg1${SENT}seg2${SENT}seg3${SENT}seg4${SENT}seg5${SENT}seg6${SENT}tail`;

			const adapter = createAnthropicMessagesAdapter();
			await adapter.generateText(
				{ ...ANTHROPIC_CONFIG_BASE, cacheStrategy: "anthropic-explicit" },
				{
					model: "claude-3-haiku-20240307",
					messages: [
						{ role: "system", content: oversized },
						{ role: "user", content: "go" },
					],
				},
				{ profile: {} as never, preset: undefined, mode: "text" },
			);

			const body = readPostedBody();
			const blocks = body.system as Array<Record<string, unknown>>;
			const cacheHintCount = blocks.filter((b) => b.cache_control).length;
			expect(cacheHintCount).toBeLessThanOrEqual(4);
			expect(cacheHintCount).toBe(4);

			// The last block is the open tail and must NOT carry cache_control.
			const lastBlock = blocks[blocks.length - 1]!;
			expect(lastBlock.cache_control).toBeUndefined();
		});

		it("leaves the trailing open segment uncached", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeTextResponse()));

			const SENT = PROMPT_CACHE_BREAKPOINT_MARKER;
			const messages: TextMessage[] = [
				{ role: "system", content: `first${SENT}second-and-tail` },
				{ role: "user", content: "go" },
			];

			const adapter = createAnthropicMessagesAdapter();
			await adapter.generateText(
				{ ...ANTHROPIC_CONFIG_BASE, cacheStrategy: "anthropic-explicit" },
				{ model: "claude-3-haiku-20240307", messages },
				{ profile: {} as never, preset: undefined, mode: "text" },
			);

			const body = readPostedBody();
			const blocks = body.system as Array<Record<string, unknown>>;
			expect(blocks).toHaveLength(2);
			expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
			expect(blocks[1]!.cache_control).toBeUndefined();
			expect(blocks[0]!.text).toBe("first");
			expect(blocks[1]!.text).toBe("second-and-tail");
		});
	});

	describe("regression: flag-off / non-explicit strategies", () => {
		it("sends a plain string `system` when cacheStrategy is omitted", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeTextResponse()));

			const adapter = createAnthropicMessagesAdapter();
			await adapter.generateText(
				ANTHROPIC_CONFIG_BASE, // no cacheStrategy
				{
					model: "claude-3-haiku-20240307",
					messages: makeMessagesWithoutCacheMarkers(),
				},
				{ profile: {} as never, preset: undefined, mode: "text" },
			);

			const body = readPostedBody();
			expect(typeof body.system).toBe("string");
			expect(body.system).toBe("You are a test narrator.");
		});

		it("sends a plain string `system` when cacheStrategy='auto-prefix'", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeTextResponse()));

			const adapter = createAnthropicMessagesAdapter();
			await adapter.generateText(
				{ ...ANTHROPIC_CONFIG_BASE, cacheStrategy: "auto-prefix" },
				{
					model: "claude-3-haiku-20240307",
					messages: makeMessagesWithCacheMarkers(),
				},
				{ profile: {} as never, preset: undefined, mode: "text" },
			);

			const body = readPostedBody();
			// auto-prefix bails out of explicit cache injection — body.system
			// stays a plain string (sentinels stripped).
			expect(typeof body.system).toBe("string");
			expect(body.system).not.toContain(PROMPT_CACHE_BREAKPOINT_MARKER);
		});

		it("sends a plain string `system` when cacheStrategy='none'", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeTextResponse()));

			const adapter = createAnthropicMessagesAdapter();
			await adapter.generateText(
				{ ...ANTHROPIC_CONFIG_BASE, cacheStrategy: "none" },
				{
					model: "claude-3-haiku-20240307",
					messages: makeMessagesWithCacheMarkers(),
				},
				{ profile: {} as never, preset: undefined, mode: "text" },
			);

			const body = readPostedBody();
			expect(typeof body.system).toBe("string");
			expect(body.system).not.toContain(PROMPT_CACHE_BREAKPOINT_MARKER);
		});

		it("still emits legacy plain-string shape when explicit strategy is set but no sentinels are present", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeTextResponse()));

			const adapter = createAnthropicMessagesAdapter();
			await adapter.generateText(
				{ ...ANTHROPIC_CONFIG_BASE, cacheStrategy: "anthropic-explicit" },
				{
					model: "claude-3-haiku-20240307",
					messages: makeMessagesWithoutCacheMarkers(),
				},
				{ profile: {} as never, preset: undefined, mode: "text" },
			);

			const body = readPostedBody();
			// No sentinels → no cache breakpoints → fallback to plain string.
			expect(typeof body.system).toBe("string");
			expect(body.system).toBe("You are a test narrator.");
		});
	});

	describe("generateObject — JSON directive stays attached to the tail", () => {
		it("appends the JSON directive to the final block, not to a cached segment", async () => {
			const objectResponse = {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers(),
				async text() {
					return JSON.stringify({
						content: [{ type: "text", text: '{"value":42}' }],
						stop_reason: "end_turn",
						usage: { input_tokens: 5, output_tokens: 5 },
					});
				},
				async json() {
					return {
						content: [{ type: "text", text: '{"value":42}' }],
						stop_reason: "end_turn",
						usage: { input_tokens: 5, output_tokens: 5 },
					};
				},
			} as unknown as Response;
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(objectResponse));

			const adapter = createAnthropicMessagesAdapter();
			const { z } = await import("zod");
			const schema = z.object({ value: z.number() });

			await adapter.generateObject(
				{ ...ANTHROPIC_CONFIG_BASE, cacheStrategy: "anthropic-explicit" },
				{
					model: "claude-3-haiku-20240307",
					schema,
					messages: makeMessagesWithCacheMarkers(),
				},
				{ profile: {} as never, preset: undefined, mode: "object" },
			);

			const body = readPostedBody();
			const blocks = body.system as Array<Record<string, unknown>>;
			expect(Array.isArray(blocks)).toBe(true);

			const last = blocks[blocks.length - 1]!;
			expect(last.text as string).toContain("Respond with JSON only.");
			// The JSON directive must NOT poison earlier cacheable segments.
			for (let i = 0; i < blocks.length - 1; i++) {
				expect(blocks[i]!.text as string).not.toContain(
					"Respond with JSON only.",
				);
			}
		});
	});

	describe("sentinel hygiene", () => {
		it("strips the sentinel from the final wire text even when the adapter builds a plain-string system", () => {
			// Direct invariant on stripPromptCacheMarkers — guards the branch
			// inside the adapter that strips sentinels when the strategy is
			// non-explicit but the caller forgot to remove them upstream.
			const input = `alpha${PROMPT_CACHE_BREAKPOINT_MARKER}beta${PROMPT_CACHE_BREAKPOINT_MARKER}gamma`;
			const cleaned = stripPromptCacheMarkers(input);
			expect(cleaned).toBe("alphabetagamma");
		});
	});
});
