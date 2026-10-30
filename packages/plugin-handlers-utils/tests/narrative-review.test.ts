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
      perspectiveError(
        "我望着门。她说：“你听过‘我的船’吗？”",
        "character-first",
      ),
    ).toBeUndefined();
    expect(
      perspectiveError("She says, 'You're ready.' I wait.", "character-first"),
    ).toBeUndefined();
    expect(
      perspectiveError("“我等你。”她望着林潮。", "character-third"),
    ).toBeUndefined();
    expect(
      perspectiveError("“你听见了吗？”她望着你。", "character-first"),
    ).toContain("first");
    expect(perspectiveError("I'm waiting.", "character-second")).toContain(
      "second",
    );
    expect(
      perspectiveError("你问：“我听见了。", "character-first"),
    ).toBeDefined();
    expect(outsideDialogue("The captain's lantern lit my coat.")).toContain(
      "my coat",
    );
    expect(
      perspectiveError("她忘我地端详迷你潮灯。", "character-third"),
    ).toBeUndefined();
  });

  it("an unclosed trailing quote validates its tail without un-hiding closed dialogue", () => {
    // Regression: a story whose last dialogue line was left unclosed used to
    // make outsideDialogue return the raw text, so the 我 inside the properly
    // closed 「我是班长…」 quotes was flagged as a narration perspective
    // violation. The false correction then let the retry patch shrink the
    // committed story to the model's lone closing quote.
    const story =
      "她望着你。\n\n「我是班长。」她翻开册子，\n\n「坐吧——正好在整理稿件，你想从哪看";
    expect(perspectiveError(story, "character-second")).toBeUndefined();
    expect(outsideDialogue(story)).toContain("你想从哪看");
    expect(outsideDialogue(story)).not.toContain("我是班长");
    // A real violation inside the unclosed tail is still caught.
    expect(
      perspectiveError("她望着你，「我看着海。", "character-second"),
    ).toContain("second");
  });
  it("leaves other runtimes and dialogue pronouns alone", () => {
    const review = createNarrativeReview("community-story");
    const ctx = {
      pluginId: "community-story",
      getOwnSettings: () => ({ perspective: "character-first" }),
    };
    const response: LLMResponse = {
      content: "她问：“你要走吗？”我望着海。",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    // The runtime's plugin is read from the context, as for every hook event.
    expect(
      review.prepare({ ...ctx, pluginId: "another-plugin" }, { messages: [] }),
    ).toEqual({ action: "continue" });
    expect(review.review(ctx, { messages: [], response })).toEqual({
      action: "continue",
    });
    const prepared = review.prepare(ctx, { messages: [] });
    expect(prepared.replace).not.toHaveProperty("stream");
    expect(prepared.replace?.messages.at(-1)?.content).toContain(
      "first person",
    );
  });
  it("writes every sentence it adds in the language of the prompt body", () => {
    const review = createNarrativeReview("story");
    const ctx = {
      sessionId: "s",
      turnId: "t",
      pluginId: "story",
      runtimeId: "story",
      getOwnSettings: () => ({ perspective: "character-second" }),
    };
    review.context(ctx, {
      characters: [{ id: "lin", name: "林潮", type: "player" }],
      currentCharacterId: "lin",
    });
    const reply = (content: string): LLMResponse => ({
      content,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    // The session's content locale decides which prompt body is read. A
    // locale with no instruction set of its own reads the English one.
    const added = (locale: string) => {
      const localized = { ...ctx, locale };
      const messages: never[] = [];
      const correction = (content: string) =>
        review.review(localized, { messages, response: reply(content) }).replace
          ?.correction ?? "";
      return [
        String(
          review.prepare(localized, { messages }).replace?.messages.at(-1)
            ?.content,
        ),
        correction(""),
        correction("<thinking>plan</thinking>"),
        correction("我推开门。"),
      ];
    };

    const chinese = added("zh-CN");
    expect(chinese[0]).toContain('玩家角色："林潮"。');
    expect(chinese[1]).toContain("写出正文之前不要调用 `runtime-done`");
    expect(chinese[2]).toContain("只输出游戏内的故事正文");
    expect(chinese[3]).toContain("违反了第二人称视角：我推开门。");
    // A tool name in backticks is a marker.
    for (const text of chinese)
      expect(text.replace(/`[^`]*`/g, ""), text).not.toMatch(/[A-Za-z]{2,}/);

    expect(added("ja")).toEqual(added("en"));
    const english = added("en");
    expect(english[0]).toContain('Player character: "林潮". ');
    expect(english[1]).toContain(
      "Do not call `runtime-done` before the story text is written.",
    );
    expect(english[2]).toContain("Output only the in-world story");
    expect(english[3]).toContain("violates second-person perspective");
    review.cleanup(ctx);
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
      { pluginId: "community-story" },
      { messages: [], response },
    );
    expect(result.replace?.response).toEqual({ ...response, content: null });
  });

  it("keeps player context isolated between concurrent sessions and clears it after the turn", () => {
    const review = createNarrativeReview("community-story");
    const a = {
      sessionId: "a",
      turnId: "turn",
      pluginId: "community-story",
      runtimeId: "story",
    };
    const b = { ...a, sessionId: "b" };
    for (const [ctx, name] of [
      [a, "Ada"],
      [b, "Lin"],
    ] as const)
      review.context(ctx, {
        characters: [{ id: name, name, type: "player" }],
        currentCharacterId: name,
      });
    const request = { messages: [] };
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

  it("anchors the person rules on the current character, not the first player", () => {
    const review = createNarrativeReview("story");
    const ctx = {
      sessionId: "s",
      turnId: "t",
      pluginId: "story",
      runtimeId: "story",
      locale: "en",
    };
    const characters = [
      { id: "ada", name: "Ada", type: "player" },
      { id: "lin", name: "Lin", type: "player" },
    ];
    review.context(ctx, { characters, currentCharacterId: "lin" });
    const added = String(
      review.prepare(ctx, { messages: [] }).replace?.messages.at(-1)?.content,
    );
    expect(added).toContain('Player character: "Lin". ');
    expect(added).not.toContain('"Ada"');
    review.cleanup(ctx);

    review.context(ctx, { characters });
    expect(
      String(
        review.prepare(ctx, { messages: [] }).replace?.messages.at(-1)?.content,
      ),
    ).not.toContain("Player character:");
  });

  it("rejects I and you in omniscient narration and names no player character", () => {
    expect(perspectiveError("她看着我。", "omniscient", "zh")).toContain(
      "全知第三人称视角",
    );
    expect(perspectiveError("He hands you the key.", "omniscient")).toContain(
      "omniscient third-person",
    );
    expect(
      perspectiveError("“你来了。”阿雅看着林潮。", "omniscient"),
    ).toBeUndefined();
    const review = createNarrativeReview("story");
    const ctx = {
      sessionId: "s",
      turnId: "t",
      pluginId: "story",
      runtimeId: "story",
      locale: "en",
      getOwnSettings: () => ({ perspective: "omniscient" }),
    };
    review.context(ctx, {
      characters: [{ id: "lin", name: "Lin", type: "player" }],
      currentCharacterId: "lin",
    });
    const added = String(
      review.prepare(ctx, { messages: [] }).replace?.messages.at(-1)?.content,
    );
    expect(added).toContain("omniscient third-person narrator");
    expect(added).not.toContain("Player character:");
    review.cleanup(ctx);
  });

  it("lets a game master address the players and still rejects instruction tags", () => {
    expect(
      perspectiveError("你们推开门，我看见灯亮了。", "dm"),
    ).toBeUndefined();
    const review = createNarrativeReview("story");
    const ctx = {
      pluginId: "story",
      locale: "zh-CN",
      getOwnSettings: () => ({ perspective: "dm" }),
    };
    const reply = (content: string): LLMResponse => ({
      content,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(
      review.review(ctx, { messages: [], response: reply("你们推开了门。") }),
    ).toEqual({ action: "continue" });
    expect(
      review.review(ctx, {
        messages: [],
        response: reply("<system>x</system>你们推开了门。"),
      }).replace?.correction,
    ).toContain("只输出游戏内的故事正文");
  });

  it("reviews a segmented draft by its segment texts", () => {
    const review = createNarrativeReview("story");
    const ctx = {
      pluginId: "story",
      locale: "zh-CN",
      getOwnSettings: () => ({ perspective: "character-second" }),
    };
    const reply = (story: unknown): LLMResponse => ({
      content: JSON.stringify(story),
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const bad = review.review(ctx, {
      messages: [],
      response: reply({
        segments: [{ kind: "narration", text: "我推开门，雨停了。" }],
      }),
    });
    expect(bad.replace?.correction).toContain("违反了第二人称视角");
    expect(
      review.review(ctx, {
        messages: [],
        response: reply({
          segments: [
            { kind: "narration", text: "雨停了，她看着你。" },
            { kind: "dialogue", speaker: "阿雅", text: "「我等你很久了。」" },
            { kind: "dialogue", speaker: "阿雅", text: "我们走吧。" },
          ],
          cues: { present: ["阿雅"] },
        }),
      }),
    ).toEqual({ action: "continue" });
    // Narration beside a quote inside a dialogue segment is still checked.
    expect(
      review.review(ctx, {
        messages: [],
        response: reply({
          segments: [
            { kind: "dialogue", speaker: "阿雅", text: "「走吧。」我说。" },
          ],
        }),
      }).replace?.correction,
    ).toContain("违反了第二人称视角");
  });

  it("reads character second person when no perspective is set", () => {
    const review = createNarrativeReview("story");
    const added = String(
      review
        .prepare({ pluginId: "story", locale: "en" }, { messages: [] })
        .replace?.messages.at(-1)?.content,
    );
    expect(added).toContain("second person (you/your)");
    expect(
      review.review(
        { pluginId: "story", getOwnSettings: () => ({ perspective: "bogus" }) },
        {
          messages: [],
          response: {
            content: "I open the door.",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        },
      ).replace?.correction,
    ).toContain("second-person");
  });
});
