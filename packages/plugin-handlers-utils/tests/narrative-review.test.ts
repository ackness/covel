import { describe, expect, it } from "vitest";
import {
  createNarrativeReview,
  outsideDialogue,
  perspectiveError,
} from "../src/narrative-review.js";
import type { LLMResponse } from "@covel/shared";

describe("narrative perspective review", () => {
  it("distinguishes narration from direct speech, nested quotes, and apostrophes", () => {
    expect(
      perspectiveError("我望着门。她说：“你听过‘我的船’吗？”", "first"),
    ).toBeUndefined();
    expect(
      perspectiveError("She says, 'You're ready.' I wait.", "first"),
    ).toBeUndefined();
    expect(perspectiveError("“我等你。”她望着林潮。", "third")).toBeUndefined();
    expect(perspectiveError("“你听见了吗？”她望着你。", "first")).toContain(
      "first",
    );
    expect(perspectiveError("I'm waiting.", "second")).toContain("second");
    expect(perspectiveError("你问：“我听见了。", "first")).toBeDefined();
    expect(outsideDialogue("The captain's lantern lit my coat.")).toContain(
      "my coat",
    );
    expect(perspectiveError("她忘我地端详迷你潮灯。", "third")).toBeUndefined();
  });

  it("an unclosed trailing quote validates its tail without un-hiding closed dialogue", () => {
    // Regression: a story whose last dialogue line was left unclosed used to
    // make outsideDialogue return the raw text, so the 我 inside the properly
    // closed 「我是班长…」 quotes was flagged as a narration perspective
    // violation. The false correction then let the retry patch shrink the
    // committed story to the model's lone closing quote.
    const story =
      "她望着你。\n\n「我是班长。」她翻开册子，\n\n「坐吧——正好在整理稿件，你想从哪看";
    expect(perspectiveError(story, "second")).toBeUndefined();
    expect(outsideDialogue(story)).toContain("你想从哪看");
    expect(outsideDialogue(story)).not.toContain("我是班长");
    // A real violation inside the unclosed tail is still caught.
    expect(perspectiveError("她望着你，「我看着海。", "second")).toContain(
      "second",
    );
  });
  it("leaves other runtimes and dialogue pronouns alone", () => {
    const review = createNarrativeReview("community-story");
    const ctx = { getOwnSettings: () => ({ narrativePerson: "first" }) };
    const response: LLMResponse = {
      content: "她问：“你要走吗？”我望着海。",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    expect(
      review.prepare(ctx, { pluginId: "another-plugin", messages: [] }),
    ).toEqual({ action: "continue" });
    expect(
      review.review(ctx, {
        pluginId: "community-story",
        messages: [],
        response,
      }),
    ).toEqual({ action: "continue" });
    const prepared = review.prepare(ctx, {
      pluginId: "community-story",
      messages: [],
    });
    expect(prepared.replace?.stream).toBe(false);
    expect(prepared.replace?.messages.at(-1)?.content).toContain(
      "first person",
    );
  });
  it("discards lookup chatter without discarding actual tool calls", () => {
    const review = createNarrativeReview("community-story");
    const response: LLMResponse = {
      content: "我先核对档案。",
      toolCalls: [
        { id: "lookup", name: "get-character", arguments: '{"name":"周陌"}' },
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const result = review.review(
      {},
      { pluginId: "community-story", messages: [], response },
    );
    expect(result.replace?.response).toEqual({ ...response, content: null });
  });

  it("keeps player context isolated between concurrent sessions and clears it after the turn", () => {
    const review = createNarrativeReview("community-story");
    const a = { sessionId: "a", turnId: "turn", runtimeId: "story" };
    const b = { ...a, sessionId: "b" };
    for (const [ctx, name] of [
      [a, "Ada"],
      [b, "Lin"],
    ] as const)
      review.context(ctx, {
        pluginId: "community-story",
        characters: [{ name, type: "player" }],
      });
    const request = { pluginId: "community-story", messages: [] };
    expect(
      review.prepare(a, request).replace?.messages.at(-1)?.content,
    ).toContain('"Ada"');
    expect(
      review.prepare(b, request).replace?.messages.at(-1)?.content,
    ).toContain('"Lin"');
    review.cleanup(a);
    expect(
      review.prepare(a, request).replace?.messages.at(-1)?.content,
    ).not.toContain('"Ada"');
    expect(
      review.prepare(b, request).replace?.messages.at(-1)?.content,
    ).toContain('"Lin"');
  });
});
