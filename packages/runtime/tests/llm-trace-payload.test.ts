/**
 * Unit tests for the llm trace payload builders.
 *
 * Covers the shared helpers that all 4 emit sites (retry sync, retry stream,
 * direct generate resume, direct generate malformed-args fallback) now use.
 * Provides coverage for the direct-generate error-path shape that Q1 fixed,
 * and locks schema drift against the spec payload contract.
 */

import { describe, it, expect } from "vitest";
import {
	buildLlmCallingPayload,
	buildLlmRespondedErrorPayload,
	buildLlmRespondedSuccessPayload,
} from "../src/llm-trace-payload.js";
import type {
	LLMMessage,
	LLMResponse,
	LLMToolDefinition,
} from "../src/llm-adapter.js";

const baseIdentity = {
	runtimeId: "narrator/main",
	pluginId: "narrator",
};

describe("buildLlmCallingPayload", () => {
	const messages: readonly LLMMessage[] = [{ role: "user", content: "ping" }];
	const tools: readonly LLMToolDefinition[] = [
		{ name: "echo", description: "echoes", parameters: { type: "object" } },
	];

	it("maps tools.parameters → tools.jsonSchema (spec schema)", () => {
		const payload = buildLlmCallingPayload({
			...baseIdentity,
			slot: "default",
			model: "default",
			provider: "deepseek",
			messages,
			tools,
			attempt: 0,
		});

		expect(payload).toMatchObject({
			runtimeId: "narrator/main",
			pluginId: "narrator",
			slot: "default",
			model: "default",
			provider: "deepseek",
			messages,
			attempt: 0,
		});
		expect(payload.tools).toEqual([
			{ name: "echo", description: "echoes", jsonSchema: { type: "object" } },
		]);
	});

	it("omits streaming flag when not provided, includes it when true", () => {
		const notStreaming = buildLlmCallingPayload({
			...baseIdentity,
			slot: "x",
			model: "x",
			provider: null,
			messages,
			tools: undefined,
			attempt: 0,
		});
		expect("streaming" in notStreaming).toBe(false);

		const streaming = buildLlmCallingPayload({
			...baseIdentity,
			slot: "x",
			model: "x",
			provider: null,
			messages,
			tools: undefined,
			attempt: 0,
			streaming: true,
		});
		expect(streaming.streaming).toBe(true);
	});

	it("accepts provider: null for direct-generate sites (survives JSON serialisation)", () => {
		const payload = buildLlmCallingPayload({
			...baseIdentity,
			slot: "x",
			model: "x",
			provider: null,
			messages,
			tools: undefined,
			attempt: 0,
		});
		// Round-trip to JSON — `null` key survives, `undefined` key would be dropped.
		const roundtripped = JSON.parse(JSON.stringify(payload)) as Record<
			string,
			unknown
		>;
		expect("provider" in roundtripped).toBe(true);
		expect(roundtripped.provider).toBeNull();
	});

	it("normalises missing tools to empty array", () => {
		const payload = buildLlmCallingPayload({
			...baseIdentity,
			slot: "x",
			model: "x",
			provider: null,
			messages,
			tools: undefined,
			attempt: 1,
		});
		expect(payload.tools).toEqual([]);
	});
});

describe("buildLlmRespondedSuccessPayload", () => {
	const response: LLMResponse = {
		content: "hi",
		toolCalls: [],
		finishReason: "stop",
		usage: { inputTokens: 10, outputTokens: 5 },
	};

	it("projects the spec schema from an LLMResponse", () => {
		const payload = buildLlmRespondedSuccessPayload({
			...baseIdentity,
			response,
			durationMs: 42,
			attempt: 0,
		});
		expect(payload).toMatchObject({
			runtimeId: "narrator/main",
			pluginId: "narrator",
			text: "hi",
			finishReason: "stop",
			usage: { inputTokens: 10, outputTokens: 5 },
			durationMs: 42,
			attempt: 0,
		});
		expect("streaming" in payload).toBe(false);
	});

	it("coerces null content to empty string (text is always a string)", () => {
		const payload = buildLlmRespondedSuccessPayload({
			...baseIdentity,
			response: { ...response, content: null },
			durationMs: 5,
			attempt: 0,
		});
		expect(payload.text).toBe("");
	});

	it("adds streaming:true when flagged", () => {
		const payload = buildLlmRespondedSuccessPayload({
			...baseIdentity,
			response,
			durationMs: 10,
			attempt: 2,
			streaming: true,
		});
		expect(payload.streaming).toBe(true);
	});
});

describe("buildLlmRespondedErrorPayload", () => {
	it("produces the error shape required by the spec (finishReason=error, usage present)", () => {
		const payload = buildLlmRespondedErrorPayload({
			...baseIdentity,
			error: new Error("fetch failed"),
			durationMs: 123,
			attempt: 0,
		});
		expect(payload).toMatchObject({
			finishReason: "error",
			error: "fetch failed",
			usage: { inputTokens: 0, outputTokens: 0 },
			durationMs: 123,
			attempt: 0,
		});
	});

	it("stringifies non-Error throwables", () => {
		const payload = buildLlmRespondedErrorPayload({
			...baseIdentity,
			error: "bare-string-boom",
			durationMs: 1,
			attempt: 0,
		});
		expect(payload.error).toBe("bare-string-boom");
	});

	it("propagates streaming flag so the streaming error path is distinguishable", () => {
		const payload = buildLlmRespondedErrorPayload({
			...baseIdentity,
			error: new Error("x"),
			durationMs: 1,
			attempt: 0,
			streaming: true,
		});
		expect(payload.streaming).toBe(true);
	});

	it("durationMs is honoured (covers Q2 non-streaming error-path parity fix)", () => {
		const payload = buildLlmRespondedErrorPayload({
			...baseIdentity,
			error: new Error("x"),
			durationMs: 999,
			attempt: 3,
		});
		expect(payload.durationMs).toBe(999);
	});
});
