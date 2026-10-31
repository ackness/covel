import { describe, expect, it } from "vitest";
import {
  buildContext,
  type ContextBuildParams,
  type MessageHistoryRecord,
  type SessionContextSnapshot,
  type TokenEstimator,
} from "@covel/context";
import {
  PROMPT_CACHE_BREAKPOINT_MARKER,
  splitPromptCacheSegments,
} from "@covel/shared";
import type { RuntimeManifest, TurnInput } from "@covel/shared";

// ── Helpers ─────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "test-rt",
    pluginId: "test-plugin",
    description: "test",
    stage: "narrative",
    ...overrides,
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "I step forward",
    origin: "player",
    ...overrides,
  };
}

function baselineParams(
  overrides?: Partial<ContextBuildParams>,
): ContextBuildParams {
  return {
    promptTemplate: "You are a test narrator.",
    manifest: makeManifest(),
    turnInput: makeTurnInput(),
    completedResults: new Map(),
    ...overrides,
  };
}

function makeSessionContext(
  overrides?: Partial<SessionContextSnapshot>,
): SessionContextSnapshot {
  return {
    sessionId: "sess-1",
    turnNumber: 1,
    locale: "zh-CN",
    sessionMeta: { turnNumber: 1, characters: [] },
    world: { id: "" },
    characters: [],
    loreEntries: [],
    summaries: [],
    contributions: [],
    ...overrides,
  };
}

// Deterministic mock estimator — ~4 chars per token.
const mockEstimator: TokenEstimator = (text) => Math.ceil(text.length / 4);

// ── Tests ───────────────────────────────────────────────────────

describe("prompt-assembler", () => {
  it.each(["event", "manual"] as const)(
    "projects %s activation payloads without changing the handler's data",
    async (source) => {
      const resultId = "0b6f6a2e-3c1d-4f5a-9b7e-1a2b3c4d5e6f";
      const rowId = "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
      const timestamp = "2026-10-14T08:00:00.000Z";
      const payload = {
        sessionId: "private-session",
        resultId,
        createdAt: timestamp,
        items: [{ id: rowId, updatedAt: timestamp, value: "gate opened" }],
        characterId: "gate-keeper",
        turn: 3,
        date: "1943-06-01T08:00:00Z",
      };
      const original = structuredClone(payload);
      const context = await buildContext(
        baselineParams({
          activation: { source, detached: true, payload },
        }),
      );
      const visible = JSON.stringify([
        context.systemPrompt,
        context.turnContext,
        context.messages,
      ]);
      for (const hidden of [resultId, rowId, timestamp, "private-session"])
        expect(visible).not.toContain(hidden);
      expect(context.turnContext).toContain("gate opened");
      expect(context.turnContext).toContain("gate-keeper");
      expect(context.turnContext).toContain('"turn":3');
      expect(context.turnContext).toContain(payload.date);
      expect(payload).toEqual(original);
    },
  );

  it("places the language constraint in segment 1 (framework preamble), not at the tail of segment 3", async () => {
    const params = baselineParams({
      promptTemplate: "Tell a story.",
      turnInput: makeTurnInput({ locale: "en-US", playerMessage: "go" }),
    });

    const result = await buildContext(params);

    // Preamble appears before the plugin body.
    const localeIdx = result.systemPrompt.indexOf("[LANGUAGE]");
    const bodyIdx = result.systemPrompt.indexOf("Tell a story.");
    expect(localeIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(localeIdx);

    // Language name is resolved from the locale map.
    expect(result.systemPrompt).toContain("English");
  });

  it("places this turn's data ahead of the current turn and keeps it out of the system prompt", async () => {
    const params = baselineParams({
      promptTemplate: "You are a downstream runtime.",
      inputSlots: {
        upstream: {
          cardinality: "one",
          value: "the upstream story",
          source: {
            pluginId: "upstream",
            runtimeId: "upstream/rt",
            resultId: "r1",
          },
        },
      },
    });

    const result = await buildContext(params);

    // A system prompt that carries this turn's data differs every turn, and
    // a provider cache stops at the first byte that differs.
    expect(result.systemPrompt).toContain("You are a downstream runtime.");
    expect(result.systemPrompt).not.toContain("<runtime-inputs>");

    const block = result.turnContext;
    expect(block).toMatch(/^<runtime-inputs>[\s\S]*the upstream story/);
    expect(result.messages).toEqual([
      { role: "system", content: block },
      { role: "user", content: "I step forward" },
    ]);
  });

  it("omits empty segments without leaving double blank lines in the output", async () => {
    const params = baselineParams({
      promptTemplate: "Line one.",
      // No locale → segment 1 empty. No injects → segment 5 empty.
      // Segments 2/4/6 are always empty in this case.
    });

    const result = await buildContext(params);

    // Only segment 3 has content, with the prompt-cache marker attached.
    expect(result.systemPrompt).toBe(
      `Line one.${PROMPT_CACHE_BREAKPOINT_MARKER}`,
    );
    // No stray blank-line separators from skipped segments.
    expect(result.systemPrompt).not.toMatch(/\n\n\n/);
  });

  it("uses a runtime execution cue for empty current player input", async () => {
    const params = baselineParams({
      turnInput: makeTurnInput({ locale: "zh-CN", playerMessage: "" }),
    });

    const result = await buildContext(params);

    expect(result.messages).toEqual([
      {
        role: "user",
        content: "开始当前游戏回合，并按照系统设定直接给出游戏内结果。",
      },
    ]);
  });

  it("uses a manual runtime cue for empty manual-trigger input", async () => {
    const params = baselineParams({
      turnInput: makeTurnInput({
        locale: "zh-CN",
        playerMessage: "",
        manualTrigger: { runtimeId: "dashscope-image-gen/prompt-generator" },
      }),
    });

    const result = await buildContext(params);

    expect(result.messages).toEqual([
      {
        role: "user",
        content:
          "执行当前手动触发的 runtime：dashscope-image-gen/prompt-generator。严格遵循系统提示中的输出格式，产出该 runtime 的结果。",
      },
    ]);
  });

  it("places the execution's story after the player message, closed by a cue, before post-history segments", async () => {
    const result = await buildContext(
      baselineParams({
        manifest: makeManifest({ pluginId: "test-rt", stage: "post-turn" }),
        turnInput: makeTurnInput({ locale: "zh-CN" }),
        messageHistory: [
          { role: "user", content: "earlier action" },
          { role: "assistant", content: "earlier story" },
        ],
        executionStory: [
          { role: "assistant", content: "this turn's story", name: "narrator" },
        ],
        promptSegments: [
          {
            id: "workflow",
            content: "workflow",
            position: "post-history",
            audience: "self",
            volatility: "stable",
            providerPluginId: "test-rt",
          },
        ],
      }),
    );

    expect(result.messages).toEqual([
      { role: "user", content: "earlier action" },
      { role: "assistant", content: "earlier story" },
      { role: "user", content: "I step forward" },
      { role: "assistant", content: "this turn's story", name: "narrator" },
      {
        role: "user",
        content:
          "上面这段正文是本回合在玩家消息之后写出的，剧情现在停在它的结尾。请按系统指令完成本 runtime 的任务。",
      },
      { role: "system", content: "workflow" },
    ]);
    // The player message and the cue: a budget pass keeps both.
    expect(result.currentTurnUserMessages).toBe(2);
  });

  it("adds no cue when the execution has produced no story", async () => {
    const result = await buildContext(baselineParams({ executionStory: [] }));

    expect(result.messages).toEqual([
      { role: "user", content: "I step forward" },
    ]);
    expect(result.currentTurnUserMessages).toBe(1);
  });

  it("renders lore_entry contributions into segmented prompt world-info segments", async () => {
    const params = baselineParams({
      promptTemplate: "Plugin body.",
      sessionContext: makeSessionContext({
        contributions: [
          {
            kind: "lore_entry",
            sourceType: "world",
            sourceId: "rain-market",
            content:
              "[World Rule: Rain Market]\nNo true names in the rain market.",
            position: "before_plugin",
            order: 10,
          },
          {
            kind: "lore_entry",
            sourceType: "world",
            sourceId: "sealed-door",
            content:
              "[World Rule: Sealed Door]\nThe sealed door answers moonlight.",
            position: "after_plugin",
            order: 20,
          },
        ],
      }),
    });

    const result = await buildContext(params);

    expect(
      result.systemPrompt.indexOf("[World Rule: Rain Market]"),
    ).toBeGreaterThan(result.systemPrompt.indexOf("Plugin body."));
    expect(
      result.systemPrompt.indexOf("[World Rule: Sealed Door]"),
    ).toBeGreaterThan(result.systemPrompt.indexOf("[World Rule: Rain Market]"));
  });

  it("inserts at-depth lore_entry contributions into the message stack", async () => {
    const params = baselineParams({
      messageHistory: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
      turnInput: makeTurnInput({ playerMessage: "current" }),
      sessionContext: makeSessionContext({
        contributions: [
          {
            kind: "lore_entry",
            sourceType: "world",
            sourceId: "sealed-door",
            content:
              "[World Rule: Sealed Door]\nThe sealed door answers moonlight.",
            position: "at_depth",
            depth: 2,
            role: "system",
            order: 0,
          },
        ],
      }),
    });

    const result = await buildContext(params);
    const loreIdx = result.messages.findIndex(
      (message) =>
        message.content ===
        "[World Rule: Sealed Door]\nThe sealed door answers moonlight.",
    );

    expect(loreIdx).toBe(2);
    expect(result.messages[loreIdx]?.role).toBe("system");
  });

  it("respects the budget-pruning pass when estimator + contextBudget are provided", async () => {
    // Large history that should be pruned down.
    const history: MessageHistoryRecord[] = [
      { role: "user", content: "a".repeat(400) },
      { role: "assistant", content: "b".repeat(400) },
      { role: "user", content: "c".repeat(400) },
      { role: "assistant", content: "d".repeat(400) },
      { role: "user", content: "recent-user-1" },
      { role: "assistant", content: "recent-asst-1" },
      { role: "user", content: "recent-user-2" },
    ];

    const params = baselineParams({
      promptTemplate: "Short system.",
      messageHistory: history,
      turnInput: makeTurnInput({ playerMessage: "final player message" }),
      estimator: mockEstimator,
      contextBudget: {
        maxInputTokens: 200,
        reservedForResponse: 50,
        protectLastUserTurns: 2,
      },
    });

    const result = await buildContext(params);

    // A synthetic placeholder system message appears at index 0 after pruning.
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toMatch(/older messages pruned/);

    // Last protected window + current user message are preserved.
    const tail = result.messages.slice(-3).map((m) => m.content);
    expect(tail).toContain("recent-user-2");
    expect(tail[tail.length - 1]).toBe("final player message");

    // Pruning actually dropped something.
    expect(result.messages.length).toBeLessThan(history.length + 2); // +2 = placeholder + current user
  });

  it("keeps the player message when a post-history section has the user role", async () => {
    const history: MessageHistoryRecord[] = [
      { role: "user", content: "a".repeat(400) },
      { role: "assistant", content: "b".repeat(400) },
    ];
    const result = await buildContext(
      baselineParams({
        manifest: makeManifest({ pluginId: "test-rt", stage: "post-turn" }),
        promptTemplate: "Short system.",
        messageHistory: history,
        turnInput: makeTurnInput({ playerMessage: "final player message" }),
        estimator: mockEstimator,
        contextBudget: { maxInputTokens: 200, reservedForResponse: 50 },
        promptSegments: [
          {
            id: "reminder",
            content: "reminder ".repeat(40),
            position: "post-history",
            role: "user",
            audience: "self",
            volatility: "stable",
            providerPluginId: "test-rt",
          },
        ],
      }),
    );

    expect(result.currentTurnUserMessages).toBe(2);
    expect(result.messages.map((m) => m.content)).toContain(
      "final player message",
    );
  });

  // ── Segment 9: Author's Note ──────────────────────────

  it("uses the segment assembler through the public buildContext entrypoint", async () => {
    const result = await buildContext(
      baselineParams({
        promptTemplate: "Plugin body.",
        turnInput: makeTurnInput({ locale: "zh-CN", playerMessage: "go" }),
      }),
    );

    expect(result.systemPrompt.startsWith("[RUNTIME]")).toBe(true);
    expect(result.systemPrompt).toContain("[LANGUAGE]");
    expect(result.systemPrompt).toContain("Plugin body.");
  });

  describe("segment 5 — available events directory", () => {
    const CATALOG = "- scene.set: Scene change (required: location: string)";

    it("renders <available-events> when advertiseEvents is true and the catalog is non-empty", async () => {
      const params = baselineParams({
        manifest: makeManifest({ advertiseEvents: true }),
        eventCatalogText: CATALOG,
      });

      const result = await buildContext(params);

      expect(result.systemPrompt).toContain("<available-events>");
      expect(result.systemPrompt).toContain(CATALOG);
      expect(result.systemPrompt).toContain("call the emit-event tool");
      expect(result.systemPrompt).toContain(
        "one call per event; the tool definition lists the topics and the payload each one takes",
      );
      expect(result.systemPrompt).not.toContain("one topic per call");
      expect(result.systemPrompt).toContain("</available-events>");
    });

    it("points Chinese event instructions to the tool definition", async () => {
      const result = await buildContext(
        baselineParams({
          manifest: makeManifest({ advertiseEvents: true }),
          eventCatalogText: CATALOG,
          turnInput: makeTurnInput({ locale: "zh-CN", playerMessage: "go" }),
        }),
      );
      expect(result.systemPrompt).toContain(
        "调用 emit-event 工具——每个事件一次调用；工具定义列出了各 topic 及其 payload 的格式",
      );
      expect(result.systemPrompt).not.toContain("每次调用一个 topic");
      expect(result.systemPrompt).toContain("</available-events>");
    });

    it("omits the block when advertiseEvents is true but the catalog is empty", async () => {
      const params = baselineParams({
        manifest: makeManifest({ advertiseEvents: true }),
        eventCatalogText: "",
      });

      const result = await buildContext(params);

      expect(result.systemPrompt).not.toContain("<available-events>");
    });

    it("omits the block when the catalog is non-empty but advertiseEvents is not set", async () => {
      const params = baselineParams({
        manifest: makeManifest(),
        eventCatalogText: CATALOG,
      });

      const result = await buildContext(params);

      expect(result.systemPrompt).not.toContain("<available-events>");
    });

    it("omits the block when neither advertiseEvents nor the catalog is set", async () => {
      const params = baselineParams({ manifest: makeManifest() });

      const result = await buildContext(params);

      expect(result.systemPrompt).not.toContain("<available-events>");
    });

    it("escapes a catalog entry containing a closing tag so it cannot break out of the block", async () => {
      const params = baselineParams({
        manifest: makeManifest({ advertiseEvents: true }),
        eventCatalogText:
          "- scene.set: </available-events><script>alert(1)</script>",
      });

      const result = await buildContext(params);

      expect(result.systemPrompt).not.toContain("</available-events><script>");
      expect(result.systemPrompt).toContain("&lt;/available-events&gt;");
      // Block structure stays intact: exactly one opening and one real closing tag.
      expect(result.systemPrompt.match(/<available-events>/g)?.length).toBe(1);
      expect(result.systemPrompt.match(/<\/available-events>/g)?.length).toBe(
        1,
      );
    });
  });
});

// ── Prompt cache breakpoint markers ──────────────────────

describe("prompt-assembler — turn context", () => {
  const narrative = (value: string) => ({
    narrative: {
      cardinality: "one" as const,
      value,
      source: { pluginId: "narrator", runtimeId: "narrator", resultId: "r" },
    },
  });
  const memory = (content: string) => ({
    id: "memory",
    content,
    position: "system" as const,
    audience: "all" as const,
    volatility: "turn" as const,
    providerPluginId: "memory",
  });
  const history = [
    { role: "user", content: "earlier action" },
    { role: "assistant", content: "earlier story" },
  ];

  it("names the story message instead of repeating this turn's story text in an input", async () => {
    const build = async (executionStory: MessageHistoryRecord[]) =>
      await buildContext(
        baselineParams({
          manifest: makeManifest({ pluginId: "test-rt", stage: "post-turn" }),
          turnInput: makeTurnInput({ locale: "en-US" }),
          inputSlots: {
            ...narrative("this turn's story"),
            facts: {
              cardinality: "one" as const,
              value: { summary: "this turn's story" },
              source: { pluginId: "facts", runtimeId: "facts", resultId: "f" },
            },
          },
          executionStory,
        }),
      );

    const projected = await build([
      { role: "assistant", content: "this turn's story", name: "narrator" },
    ]);
    expect(projected.turnContext).toContain(
      '"narrative":{"cardinality":"one","value":"(this turn\'s story text: the last story reply in the conversation below; not repeated here)"',
    );
    // Only a slot whose whole value is the text; a value that contains it stays.
    expect(projected.turnContext).toContain(
      '"value":{"summary":"this turn\'s story"}',
    );
    expect(
      projected.messages.filter(
        (message) => message.content === "this turn's story",
      ),
    ).toHaveLength(1);

    // A retry after the commit: the text is in the history, not projected.
    expect((await build([])).turnContext).toContain(
      '"narrative":{"cardinality":"one","value":"this turn\'s story"',
    );
  });

  // The reason for the layout: a provider serves a request from its cache
  // only as far as it matches an earlier one from the first byte.
  it("keeps the system prompt and the history identical from turn to turn", async () => {
    const turn = async (
      inputs: string,
      block: string,
      extra: MessageHistoryRecord[],
    ) =>
      await buildContext(
        baselineParams({
          turnInput: makeTurnInput({ locale: "en-US" }),
          activation: { source: "stage", detached: false, payload: null },
          messageHistory: [...history, ...extra],
          inputSlots: narrative(inputs),
          promptSegments: [memory(block)],
        }),
      );
    const first = await turn("story one", "goal: find the artifact", []);
    const second = await turn("story two", "goal: leave the barrow", [
      { role: "user", content: "I step forward" },
      { role: "assistant", content: "story one" },
    ]);

    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.messages.slice(0, history.length)).toEqual(
      first.messages.slice(0, history.length),
    );
    expect(first.turnContext).toContain("story one");
    expect(first.turnContext).toContain("goal: find the artifact");
    expect(second.turnContext).toContain("story two");
  });

  it("places the turn context between the history and the current turn", async () => {
    const result = await buildContext(
      baselineParams({
        manifest: makeManifest({ pluginId: "test-rt", stage: "post-turn" }),
        turnInput: makeTurnInput({ locale: "en-US" }),
        messageHistory: history,
        executionStory: [{ role: "assistant", content: "this turn's story" }],
        inputSlots: narrative("this turn's story"),
        promptSegments: [
          memory("goal: find the artifact"),
          {
            id: "note",
            content: "note",
            position: { depth: 0 },
            audience: "all",
            volatility: "stable",
            providerPluginId: "lore",
          },
          {
            id: "workflow",
            content: "workflow",
            position: "post-history",
            audience: "all",
            volatility: "stable",
            providerPluginId: "test-rt",
          },
        ],
      }),
    );

    // The request ends on the current turn and the workflow, as it did with
    // the data in the system prompt. A data block as the last thing before
    // the reply leaked its syntax into small models' tool calls.
    expect(
      result.messages.map(({ role, content }) =>
        content === result.turnContext ? "turn context" : `${role}: ${content}`,
      ),
    ).toEqual([
      "user: earlier action",
      "assistant: earlier story",
      "turn context",
      "user: I step forward",
      "assistant: this turn's story",
      `user: ${result.messages.at(-3)?.content}`,
      "system: note",
      "system: workflow",
    ]);
    expect(result.messages[2]?.role).toBe("system");
    // Data blocks first, then the turn-volatile segments, as one message.
    expect(result.turnContext).toMatch(
      /^<runtime-inputs>\n[^\n]+\n<\/runtime-inputs>\n\ngoal: find the artifact$/,
    );
  });

  it("keeps a staged activation in the system prompt and treats an event's as data of the run", async () => {
    const staged = await buildContext(
      baselineParams({
        activation: { source: "stage", detached: false, payload: null },
      }),
    );
    // The same block every turn: it does not unsettle the system prompt, and
    // a runtime without inputs gets no extra message.
    expect(staged.systemPrompt).toContain("<runtime-activation>");
    expect(staged.turnContext).toBe("");
    expect(staged.messages).toEqual([
      { role: "user", content: "I step forward" },
    ]);

    const event = await buildContext(
      baselineParams({
        activation: {
          source: "event",
          detached: false,
          payload: { topic: "check.resolved" },
        },
      }),
    );
    expect(event.systemPrompt).not.toContain("<runtime-activation>");
    expect(event.turnContext).toContain("check.resolved");
  });
});

describe("prompt-assembler — cache breakpoints", () => {
  it("emits markers after segment 1 and segment 3", async () => {
    const params = baselineParams({
      promptTemplate: "Plugin body.",
      turnInput: makeTurnInput({ locale: "en-US" }),
    });

    const result = await buildContext(params);

    const segments = splitPromptCacheSegments(result.systemPrompt);
    // Two non-empty cacheable breakpoints in this baseline: segment 1
    // (framework preamble) and segment 3 (plugin instructions). Segment 6
    // (worldInfoAfterPlugin) is empty and therefore produces no marker.
    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain("[LANGUAGE]");
    expect(segments[1]).toContain("Plugin body.");
  });

  it("moves a turn-varying system segment out of the system prompt, ahead of the current turn", async () => {
    const params = baselineParams({
      promptTemplate: "Plugin body.",
      turnInput: makeTurnInput({ locale: "en-US" }),
      promptSegments: [
        {
          id: "memory",
          position: "system",
          audience: "all",
          volatility: "turn",
          content: "goal: find the artifact",
        },
      ],
    });

    const result = await buildContext(params);

    // Memory changes every turn. In the system prompt it made every request
    // differ from the last one ahead of the whole history.
    expect(result.systemPrompt).not.toContain("goal");
    expect(result.systemPrompt.endsWith(PROMPT_CACHE_BREAKPOINT_MARKER)).toBe(
      true,
    );
    expect(result.messages).toEqual([
      { role: "system", content: "goal: find the artifact" },
      { role: "user", content: "I step forward" },
    ]);
    expect(result.turnContext).toBe("goal: find the artifact");
  });

  it("keeps a turn-varying pre-history segment in the system prompt, where it anchors no breakpoint", async () => {
    const params = baselineParams({
      promptTemplate: "Plugin body.",
      turnInput: makeTurnInput({ locale: "en-US" }),
      promptSegments: [
        {
          id: "roster",
          position: "pre-history",
          audience: "all",
          volatility: "turn",
          content: "goal: find the artifact",
        },
      ],
    });

    const result = await buildContext(params);
    const segments = splitPromptCacheSegments(result.systemPrompt);

    // The segment asked for a place ahead of the history and keeps it. It
    // trails every marker as an unmarked tail, so the instructions ahead of
    // it stay cacheable.
    const frameworkSegment = segments[0];
    expect(frameworkSegment).toContain("[LANGUAGE]");
    expect(frameworkSegment).not.toContain("goal");

    const pluginSegment = segments[1];
    expect(pluginSegment).toContain("Plugin body.");
    expect(pluginSegment).not.toContain("goal");

    expect(segments.at(-1)).toContain("goal");
    expect(result.systemPrompt.endsWith(PROMPT_CACHE_BREAKPOINT_MARKER)).toBe(
      false,
    );
  });

  it("does not emit markers for empty optional segments", async () => {
    // No locale → segment 1 empty; no upstream inject → segment 5 empty.
    const params = baselineParams({
      promptTemplate: "Plugin body.",
      turnInput: makeTurnInput(), // no locale
    });

    const result = await buildContext(params);
    const segments = splitPromptCacheSegments(result.systemPrompt);

    // Only segment 3 survives → single breakpoint only.
    expect(segments).toHaveLength(1);
    expect(segments[0]).toContain("Plugin body.");
  });

  it("never places a breakpoint on the history (messages stay unchanged)", async () => {
    const params = baselineParams({
      promptTemplate: "Plugin body.",
      turnInput: makeTurnInput({ locale: "en-US", playerMessage: "go north" }),
      messageHistory: [
        { role: "user", content: "prior 1" },
        { role: "assistant", content: "prior 2" },
      ] satisfies readonly MessageHistoryRecord[],
    });

    const result = await buildContext(params);

    for (const msg of result.messages) {
      expect(msg.content).not.toContain(PROMPT_CACHE_BREAKPOINT_MARKER);
    }
  });
});
