import { describe, expect, it } from "vitest";
import { __testOnly_parseFinalOutputEnvelope as parse } from "../src/turn-executor.js";

describe("parseFinalOutputEnvelope", () => {
	it("parses a clean JSON object directly", () => {
		const r = parse('{"prompt":"x","events":[{"topic":"t","data":{}}]}');
		expect(r.parsedAsJson).toBe(true);
		expect(r.output).toEqual({
			prompt: "x",
			events: [{ topic: "t", data: {} }],
		});
	});

	it("strips ```json``` fence and parses", () => {
		const r = parse('```json\n{"a":1}\n```');
		expect(r.parsedAsJson).toBe(true);
		expect(r.output).toEqual({ a: 1 });
	});

	it("strips a bare ``` fence and parses", () => {
		const r = parse('```\n{"a":1}\n```');
		expect(r.parsedAsJson).toBe(true);
		expect(r.output).toEqual({ a: 1 });
	});

	it("falls back to narrativeOutput when content is plain prose", () => {
		const r = parse("Just a story, no JSON anywhere.");
		expect(r.parsedAsJson).toBe(false);
		expect(r.output).toEqual({
			narrativeOutput: "Just a story, no JSON anywhere.",
		});
	});

	it("salvages a trailing JSON envelope when LLM emits prose+JSON", () => {
		// Real failure mode observed with prompt-generator: model continues the
		// narrative before the canonical envelope. Without lenient extraction
		// the events[] array is dropped and the follower runtime never fires.
		const text =
			"通道的蓝色冷光在你面前铺开...\n\n你接过她手中的潮石灯。\n\n" +
			'{"prompt":"a misty harbor","promptMode":"text","events":[{"topic":"image.generate.requested","data":{"prompt":"a misty harbor","promptMode":"text"}}]}';
		const r = parse(text);
		expect(r.parsedAsJson).toBe(true);
		expect(r.output.prompt).toBe("a misty harbor");
		expect(r.output.promptMode).toBe("text");
		const events = r.output.events as Array<Record<string, unknown>>;
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ topic: "image.generate.requested" });
	});

	it("returns the LAST balanced object when prose contains multiple JSONs", () => {
		// A mid-text {} sample shouldn't shadow the actual trailing envelope.
		const text =
			'For example: {"sample":"ignore-me"}.\n\nFinal output:\n{"final":true,"events":[]}';
		const r = parse(text);
		expect(r.parsedAsJson).toBe(true);
		expect(r.output).toEqual({ final: true, events: [] });
	});

	it("ignores braces inside JSON strings when scanning depth", () => {
		// The inner string contains literal `{` and `}` characters — the depth
		// tracker must respect string state or it will report unbalanced braces.
		const text = 'prefix {"text":"contains { and } literally","ok":true}';
		const r = parse(text);
		expect(r.parsedAsJson).toBe(true);
		expect(r.output).toEqual({ text: "contains { and } literally", ok: true });
	});

	it("handles escaped quotes inside JSON strings", () => {
		const text = 'noise {"q":"a \\"quoted\\" word","n":1}';
		const r = parse(text);
		expect(r.parsedAsJson).toBe(true);
		expect(r.output).toEqual({ q: 'a "quoted" word', n: 1 });
	});

	it("rejects arrays — only objects are salvaged", () => {
		const r = parse("Some prose ending in [1,2,3] should not match.");
		expect(r.parsedAsJson).toBe(false);
		expect(r.output).toEqual({
			narrativeOutput: "Some prose ending in [1,2,3] should not match.",
		});
	});

	it("returns narrative when prose contains only unbalanced braces", () => {
		const r = parse("Half open { but never closed in any meaningful way.");
		expect(r.parsedAsJson).toBe(false);
		expect((r.output as Record<string, unknown>).narrativeOutput).toContain(
			"Half open",
		);
	});
});
