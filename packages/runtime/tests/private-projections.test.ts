import { describe, expect, it } from "vitest";
import type { LLMMessage } from "@covel/shared";
import { createLoopContextPolicy } from "../src/agent-loop/loop-context-policy.js";
import { PrivateDelegationProjection } from "../src/orchestration/private-projections.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";

describe("private delegation transcript copies", () => {
  it("keeps native state and business intent when no private call was recorded", async () => {
    const inner = makeEmitterSpy();
    const emitter = new PrivateDelegationProjection().emitter(inner, [])!;
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: '{"intent":"public business data"}',
        reasoningContent: "public reasoning",
        providerContinuation: {
          protocol: "openai-responses-v1",
          model: "fixture",
          items: [{ type: "reasoning", encrypted_content: "opaque" }],
        },
      },
    ];
    await emitter.emit("llm.calling", { messages });
    expect(inner.events[0]?.payload.messages).toEqual(messages);
  });

  it.each(["normal", "emergency"] as const)(
    "projects private digest lines and replays their provenance in %s mode",
    async (mode) => {
      const transcript: LLMMessage[] = [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "private-call",
              name: "delegate",
              arguments: '{"brief":"PRIVATE-BRIEF"}',
            },
            {
              id: "public-call",
              name: "read",
              arguments: '{"intent":"public business data"}',
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "private-call",
          content: '{"summary":"PRIVATE-SUMMARY"}',
        },
        {
          role: "tool",
          toolCallId: "public-call",
          content: '{"summary":"public result"}',
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "latest-call", name: "read", arguments: "{}" }],
        },
        { role: "tool", toolCallId: "latest-call", content: "latest result" },
      ];
      const original = structuredClone(transcript);
      const policy = createLoopContextPolicy({});
      const fit = (input: readonly LLMMessage[], inputLimit: number) =>
        policy.fit(input, {
          mode,
          inputLimit,
          fixedTokens: 0,
          estimator: (text) => text.length,
        });
      const first = fit(transcript, 1);
      expect(first.collapsedStepCount).toBe(mode === "normal" ? 1 : 2);
      const liveDigest = first.messages[0]!;
      expect(liveDigest.content).toContain("PRIVATE-BRIEF");
      expect(liveDigest.content).toContain("PRIVATE-SUMMARY");
      expect(JSON.stringify(liveDigest)).not.toContain("private-call");

      const privacy = new PrivateDelegationProjection(["private-call"]);
      const inner = makeEmitterSpy();
      const emitter = privacy.emitter(inner, [])!;
      // Matching text alone must not confer kernel digest provenance.
      const ordinaryMessage = { role: "system", content: liveDigest.content };
      for (const fitted of [first, fit(structuredClone(transcript), 100_000)]) {
        expect(fitted).toEqual(first);
        await emitter.emit("llm.calling", { messages: fitted.messages });
        const trace = JSON.stringify(inner.events.at(-1));
        expect(trace).not.toMatch(/PRIVATE-BRIEF|PRIVATE-SUMMARY/);
        expect(trace).toContain("[Private delegation step]");
        expect(trace).toContain("public business data");
        expect(trace).toContain("public result");
        expect(fitted.messages[0]?.content).toBe(liveDigest.content);
      }
      await emitter.emit("llm.calling", { messages: [ordinaryMessage] });
      expect(inner.events.at(-1)?.payload.messages).toEqual([ordinaryMessage]);
      expect(transcript).toEqual(original);
    },
  );
});
