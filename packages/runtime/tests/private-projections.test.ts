import { describe, expect, it } from "vitest";
import { CHARACTER_ACTOR_CONTRACT, type RuntimeManifest } from "@covel/shared";
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

  it.each(
    (["normal", "emergency"] as const).flatMap((mode) =>
      ["delegate", "delegate-batch"].map((name) => ({ mode, name })),
    ),
  )(
    "projects private digest lines and replays their provenance in $mode mode with $name",
    async ({ mode, name }) => {
      const transcript: LLMMessage[] = [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "private-call",
              name,
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

it("learns private batch provenance before tracing malformed mixed entries and safely completes", async () => {
  const privacy = new PrivateDelegationProjection();
  const inner = makeEmitterSpy();
  const providers: RuntimeManifest[] = [
    {
      name: "actor/play",
      pluginId: "actor",
      description: "actor",
      runtimeType: "agent",
      outputContract: CHARACTER_ACTOR_CONTRACT,
      subagentOnly: true,
      trigger: { type: "manual" },
    },
    {
      name: "secret/play",
      pluginId: "secret",
      description: "secret",
      runtimeType: "agent",
      outputContract: "test.concealed@1",
      concealed: true,
      subagentOnly: true,
      trigger: { type: "manual" },
    },
  ];
  const emitter = privacy.emitter(inner, providers)!;
  for (const contract of [CHARACTER_ACTOR_CONTRACT, "test.concealed@1"]) {
    const id = `batch-${contract}`;
    const args = JSON.stringify({
      requests: [
        { target: { contract: "test.generic@1" }, brief: "GENERIC-BRIEF" },
        { target: { contract }, brief: 123, instruction: "PRIVATE-BRIEF" },
      ],
    });
    await emitter.emit("llm.responded", {
      runtimeId: "parent",
      pluginId: "caller",
      toolCalls: [{ id, name: "delegate-batch", arguments: args }],
      reasoningContent: "PRIVATE-REASONING",
      providerContinuation: { secret: "PRIVATE-NATIVE" },
    });
    expect(privacy.calls.has(id)).toBe(true);
    await emitter.emit("tool.calling", { toolCallId: id, arguments: args });
    await emitter.emit("tool.completed", {
      toolCallId: id,
      result: "PRIVATE-INTENT",
    });
    await emitter.emit("llm.calling", {
      messages: [
        {
          role: "assistant",
          toolCalls: [{ id, name: "delegate-batch", arguments: args }],
        },
        { role: "tool", toolCallId: id, content: "PRIVATE-INTENT" },
      ],
      providerRequests: ["PRIVATE-WIRE"],
    });
    expect(
      privacy.completion(id, {
        results: [{ ok: true, output: { intent: "PRIVATE-INTENT" } }],
      }),
    ).toEqual({});
    expect(
      privacy.record({
        toolCallId: id,
        toolName: "delegate-batch",
        pluginId: "caller",
        runtimeId: "parent",
        turnId: "turn",
        input: args,
        output: "PRIVATE-INTENT",
        approvalStatus: "auto-allowed",
        timestamp: "",
        durationMs: 0,
      }),
    ).toMatchObject({ input: null, output: null });
  }
  expect(JSON.stringify(inner.events)).not.toMatch(/PRIVATE-|GENERIC-BRIEF/);
  expect(inner.events.some((e) => e.payload.concealed === true)).toBe(true);
});
