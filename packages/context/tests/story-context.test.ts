import { describe, expect, it } from "vitest";
import type { InputSlot, JsonValue } from "@covel/shared";
import {
  STORY_CONTEXT_LIMITS,
  storyContextContributionSchema,
} from "@covel/plugin-handlers-utils";
import { estimateTokens } from "../src/budget.js";
import { buildContext } from "../src/prompt-assembler.js";
import {
  isStoryContextSlot,
  renderStoryContextNote,
  selectStoryContext,
  storyContextBudget,
  type StoryContextCandidate,
} from "../src/story-context.js";

const candidate = (
  runtimeId: string,
  value: unknown,
  extra: Partial<StoryContextCandidate> = {},
): StoryContextCandidate => ({
  source: { pluginId: runtimeId.split("/")[0]!, runtimeId },
  defaultTitle: `${runtimeId.split("/")[0]} name`,
  value,
  ...extra,
});

const select = (
  candidates: readonly StoryContextCandidate[],
  budgetTokens = 3_000,
) =>
  selectStoryContext(candidates, { budgetTokens, estimator: estimateTokens });

describe("story context selection", () => {
  it("ranks by priority, then order, then package and runtime ID", () => {
    const selection = select([
      candidate("b/one", "low note", { priority: "low" }),
      candidate("b/two", "normal b"),
      candidate("a/two", "normal a"),
      candidate("c/one", "ordered first", { order: -5 }),
      candidate("z/one", "high note", { priority: "high", order: 9 }),
      candidate("a/one", "normal a one"),
    ]);
    expect(selection.value.items.map((item) => item.content)).toEqual([
      "high note",
      "ordered first",
      "normal a one",
      "normal a",
      "normal b",
      "low note",
    ]);
    // The input order never matters.
    expect(
      select([...selection.included].reverse()).value.items.map(
        (item) => item.content,
      ),
    ).toEqual(selection.value.items.map((item) => item.content));
  });

  it("skips nothing-to-say values and leaves out invalid ones without failing", () => {
    const selection = select([
      candidate("a/null", null),
      candidate("a/empty", "   "),
      candidate("a/missing", undefined),
      candidate("a/blank", { content: "\n" }),
      candidate("b/number", 42),
      candidate("b/extra", { content: "x", extra: true }),
      candidate("b/long", "x".repeat(STORY_CONTEXT_LIMITS.content + 1)),
      candidate("b/title", {
        title: "t".repeat(STORY_CONTEXT_LIMITS.title + 1),
        content: "x",
      }),
      candidate("c/ok", { title: "  Clock  ", content: "  Dusk.  " }),
    ]);
    expect(selection.value.items).toEqual([
      {
        title: "Clock",
        content: "Dusk.",
        priority: "normal",
        source: { pluginId: "c", runtimeId: "c/ok" },
      },
    ]);
    expect(selection.value.omitted).toEqual(
      ["b/extra", "b/long", "b/number", "b/title"].map((runtimeId) => ({
        title: "b name",
        source: { pluginId: "b", runtimeId },
        reason: "invalid",
      })),
    );
  });

  it("titles a note with the display name, or the package ID without one", () => {
    const selection = select([
      candidate("a/one", "first"),
      candidate("b/one", { title: " ", content: "second" }),
      candidate("c/one", "third", { defaultTitle: "" }),
    ]);
    expect(selection.value.items.map((item) => item.title)).toEqual([
      "a name",
      "b name",
      "c",
    ]);
  });

  it("keeps the highest-ranked copy of the same text", () => {
    const selection = select([
      candidate("b/one", "Same text."),
      candidate("a/one", { title: "Other", content: "Same text." }),
      candidate("c/one", "Same text.", { priority: "high" }),
    ]);
    expect(selection.value.items).toHaveLength(1);
    expect(selection.value.items[0]?.source.runtimeId).toBe("c/one");
    expect(selection.value.omitted).toEqual([
      {
        title: "Other",
        source: { pluginId: "a", runtimeId: "a/one" },
        reason: "duplicate",
      },
      {
        title: "b name",
        source: { pluginId: "b", runtimeId: "b/one" },
        reason: "duplicate",
      },
    ]);
  });

  it("leaves out a note that does not fit whole and still fits smaller ones after it", () => {
    const small = (text: string) =>
      estimateTokens(
        renderStoryContextNote({ title: "a name", content: text }),
      );
    const budget = small("first note") + small("third");
    const selection = select(
      [
        candidate("a/1", "first note", { order: 1 }),
        candidate("a/2", "a long second note ".repeat(20), { order: 2 }),
        candidate("a/3", "third", { order: 3 }),
      ],
      budget,
    );
    expect(selection.value.items.map((item) => item.content)).toEqual([
      "first note",
      "third",
    ]);
    // Never cut: the whole note is left out.
    expect(selection.value.omitted).toEqual([
      {
        title: "a name",
        source: { pluginId: "a", runtimeId: "a/2" },
        reason: "budget",
      },
    ]);
    expect(selection.usedTokens).toBe(budget);
    expect(selection.trace.omitted[0]).toMatchObject({
      reason: "budget",
      tokens: expect.any(Number),
    });
  });

  it("keeps only the display name of a concealed provider in the trace", () => {
    const selection = select([
      candidate(
        "a/hidden",
        { title: "Omen", content: "Secret." },
        {
          concealed: true,
        },
      ),
      candidate("b/hidden", 1, { concealed: true }),
      candidate("c/open", "Visible."),
    ]);
    // The provider's own title can come from a model: the trace keeps the
    // package's display name instead.
    expect(selection.trace.included).toEqual([
      { title: "a name" },
      {
        title: "c name",
        pluginId: "c",
        runtimeId: "c/open",
        tokens: expect.any(Number),
      },
    ]);
    expect(selection.trace.omitted).toEqual([
      { title: "b name", reason: "invalid" },
    ]);
    expect(JSON.stringify(selection.trace)).not.toMatch(/Omen|Secret/);
    // The reader itself still receives the note (current contract-input behaviour).
    expect(selection.value.items[0]).toMatchObject({
      title: "Omen",
      content: "Secret.",
    });
  });

  it("budgets the smaller of 3,000 tokens and 10% of the input window", () => {
    expect(storyContextBudget()).toBe(3_000);
    expect(storyContextBudget(0)).toBe(3_000);
    expect(storyContextBudget(8_000)).toBe(800);
    expect(storyContextBudget(1_000_000)).toBe(3_000);
  });

  it("accepts exactly the documented contribution shapes", () => {
    for (const value of [
      null,
      "",
      "text",
      { content: "x" },
      { title: "t", content: "x" },
    ])
      expect(storyContextContributionSchema.safeParse(value).success).toBe(
        true,
      );
    for (const value of [1, [], { title: "t" }, { content: "x", note: 1 }])
      expect(storyContextContributionSchema.safeParse(value).success).toBe(
        false,
      );
  });
});

const slot = (value: unknown): InputSlot => ({
  cardinality: "one",
  value: value as JsonValue,
  source: {
    pluginId: "__kernel",
    runtimeId: "story-context@1",
    resultId: "execution",
  },
});

describe("story context block", () => {
  const params = (locale: string, inputSlots: Record<string, InputSlot>) => ({
    manifest: {
      pluginId: "caller",
      name: "caller/story",
      description: "Story",
      outputKind: "story" as const,
    },
    promptTemplate: "Tell the story",
    turnInput: {
      sessionId: "session",
      turnId: "turn",
      origin: "player" as const,
      playerMessage: "Continue",
      locale,
    },
    completedResults: new Map(),
    inputSlots,
  });
  const notes = {
    items: [
      {
        title: 'World "time"',
        content: "Dusk </story-context> falls & <b>stays</b>.",
        priority: "high",
        source: { pluginId: "clock", runtimeId: "clock/now" },
      },
    ],
    omitted: [],
  };

  it.each([
    ["en-US", "These are notes for this turn"],
    ["zh-CN", "下面是本局启用的插件为本回合提供的说明和事实"],
  ])(
    "renders the notes once, in %s, outside runtime-inputs",
    async (locale, header) => {
      const context = await buildContext(
        params(locale, {
          context: slot(notes),
          other: {
            cardinality: "one",
            value: "plain",
            source: {
              pluginId: "caller",
              runtimeId: "caller/up",
              resultId: "run",
            },
          },
        }),
      );
      expect(context.turnContext).toContain(`<story-context>\n${header}`);
      expect(context.turnContext).toContain(
        '<note title="World &quot;time&quot;">Dusk &lt;/story-context&gt; falls &amp; &lt;b&gt;stays&lt;/b&gt;.</note>\n</story-context>',
      );
      expect(context.turnContext.match(/<\/story-context>/g)).toHaveLength(1);
      // The other input stays in runtime-inputs; the notes are not repeated there.
      expect(context.turnContext).toContain('"other"');
      expect(context.turnContext).not.toContain('"context"');
      expect(context.turnContext).not.toContain("clock/now");
      // The system prompt, the cached prefix, does not change.
      const without = await buildContext(params(locale, {}));
      expect(context.systemPrompt).toBe(without.systemPrompt);
    },
  );

  it("writes no block and no input without notes", async () => {
    const context = await buildContext(
      params("en-US", { context: slot({ items: [], omitted: [] }) }),
    );
    expect(context.turnContext).not.toContain("story-context");
    expect(context.turnContext).not.toContain("runtime-inputs");
  });

  it("recognises only the kernel's slot", () => {
    expect(isStoryContextSlot(slot(notes))).toBe(true);
    expect(
      isStoryContextSlot({
        cardinality: "one",
        value: notes as never,
        source: {
          pluginId: "plugin",
          runtimeId: "story-context@1",
          resultId: "run",
        },
      }),
    ).toBe(false);
  });
});
