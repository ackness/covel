import { describe, expect, it } from "vitest";
import {
  buildContext,
  buildSegmentedContext,
  type ContextBuildParams,
  type MessageHistoryRecord,
  type SessionContextSnapshot,
  type TokenEstimator,
} from "@covel/context";
import {
  PROMPT_CACHE_BREAKPOINT_MARKER,
  splitPromptCacheSegments,
} from "@covel/shared";
import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";

// ── Helpers ─────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "test-rt",
    description: "test",
    priority: 500,
    ...overrides,
  };
}

function makeRuntimeResult(overrides?: Partial<RuntimeResult>): RuntimeResult {
  return {
    pluginId: "test-plugin",
    runtimeId: "test-rt",
    runId: "run-1",
    turnId: "turn-1",
    status: "success",
    output: {},
    toolCalls: [],
    durationMs: 10,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "I step forward",
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
    workingMemory: [],
    coreMemoryBlocks: [],
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
  it("matches the public buildContext entrypoint for a locale-less, inject-less baseline", () => {
    const params = baselineParams({
      promptTemplate: "You are a narrator. Respond to {{ player.message }}.",
      turnInput: makeTurnInput({ playerMessage: "hello world" }),
    });

    const publicContext = buildContext(params);
    const result = buildSegmentedContext(params);

    expect(result.systemPrompt).toBe(publicContext.systemPrompt);
    expect(result.messages).toEqual(publicContext.messages);
  });

  it("places the language constraint in segment 1 (framework preamble), not at the tail of segment 3", () => {
    const params = baselineParams({
      promptTemplate: "Tell a story.",
      turnInput: makeTurnInput({ locale: "en-US", playerMessage: "go" }),
    });

    const result = buildSegmentedContext(params);

    // Preamble appears before the plugin body.
    const localeIdx = result.systemPrompt.indexOf("[LANGUAGE]");
    const bodyIdx = result.systemPrompt.indexOf("Tell a story.");
    expect(localeIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(localeIdx);

    // Language name is resolved from the locale map.
    expect(result.systemPrompt).toContain("English");

    const publicContext = buildContext(params);
    expect(publicContext.systemPrompt).toBe(result.systemPrompt);
  });

  it("places upstream injects in segment 5, after plugin instructions, before messages", () => {
    const params = baselineParams({
      promptTemplate: "You are a downstream runtime.",
      manifest: makeManifest({
        input: {
          inject: [
            {
              kind: "runtime",
              from: "upstream/rt",
              field: "narrativeOutput",
              as: "<upstream-output>",
            },
          ],
        },
      }),
      completedResults: new Map([
        [
          "upstream/rt",
          makeRuntimeResult({
            output: { narrativeOutput: "the upstream story" },
          }),
        ],
      ]),
    });

    const result = buildSegmentedContext(params);

    const bodyIdx = result.systemPrompt.indexOf(
      "You are a downstream runtime.",
    );
    const injectIdx = result.systemPrompt.indexOf(
      "<upstream-output>the upstream story</upstream-output>",
    );
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(injectIdx).toBeGreaterThan(bodyIdx);

    // Messages array still only contains the current user turn.
    expect(result.messages).toEqual([
      { role: "user", content: "I step forward" },
    ]);
  });

  it("omits empty segments without leaving double blank lines in the output", () => {
    const params = baselineParams({
      promptTemplate: "Line one.",
      // No locale → segment 1 empty. No injects → segment 5 empty.
      // Segments 2/4/6 are always empty in this case.
    });

    const result = buildSegmentedContext(params);

    // Only segment 3 has content, with the prompt-cache marker attached.
    expect(result.systemPrompt).toBe(
      `Line one.${PROMPT_CACHE_BREAKPOINT_MARKER}`,
    );
    // No stray blank-line separators from skipped segments.
    expect(result.systemPrompt).not.toMatch(/\n\n\n/);
  });

  it("uses a runtime execution cue for empty current player input", () => {
    const params = baselineParams({
      turnInput: makeTurnInput({ locale: "zh-CN", playerMessage: "" }),
    });

    const result = buildSegmentedContext(params);

    expect(result.messages).toEqual([
      {
        role: "user",
        content: "开始当前游戏回合，并按照系统设定直接给出游戏内结果。",
      },
    ]);
  });

  it("uses a manual runtime cue for empty manual-trigger input", () => {
    const params = baselineParams({
      turnInput: makeTurnInput({
        locale: "zh-CN",
        playerMessage: "",
        manualTrigger: { runtimeId: "dashscope-image-gen/prompt-generator" },
      }),
    });

    const result = buildSegmentedContext(params);

    expect(result.messages).toEqual([
      {
        role: "user",
        content:
          "执行当前手动触发的 runtime：dashscope-image-gen/prompt-generator。严格遵循系统提示中的输出格式，产出该 runtime 的结果。",
      },
    ]);
  });

  it("prepends active persona contributions to segment 3", () => {
    const params = baselineParams({
      promptTemplate: "Plugin body.",
      sessionContext: makeSessionContext({
        activePersona: {
          id: "wanderer",
          name: "Wanderer",
          description: "A cautious outsider.",
        },
        contributions: [
          {
            kind: "persona_description",
            sourceType: "persona",
            sourceId: "wanderer",
            content:
              "[Player Persona]\nName: Wanderer\nDescription: A cautious outsider.",
            position: "seg3_prepend",
            order: 0,
          },
        ],
      }),
    });

    const result = buildSegmentedContext(params);

    expect(
      result.systemPrompt.indexOf("[Player Persona]"),
    ).toBeGreaterThanOrEqual(0);
    expect(result.systemPrompt.indexOf("Plugin body.")).toBeGreaterThan(
      result.systemPrompt.indexOf("[Player Persona]"),
    );
  });

  it("inserts at-depth persona contributions into the message stack", () => {
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
            kind: "persona_description",
            sourceType: "persona",
            sourceId: "wanderer",
            content: "[Player Persona]\nName: Wanderer",
            position: "at_depth",
            depth: 1,
            role: "system",
            order: 0,
          },
        ],
      }),
    });

    const result = buildSegmentedContext(params);
    const personaIdx = result.messages.findIndex(
      (message) => message.content === "[Player Persona]\nName: Wanderer",
    );

    expect(personaIdx).toBe(3);
    expect(result.messages[personaIdx]?.role).toBe("system");
    expect(result.messages[result.messages.length - 1]?.content).toBe(
      "current",
    );
  });

  it("renders lore_entry contributions into segmented prompt world-info segments", () => {
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

    const result = buildSegmentedContext(params);

    expect(
      result.systemPrompt.indexOf("[World Rule: Rain Market]"),
    ).toBeGreaterThan(result.systemPrompt.indexOf("Plugin body."));
    expect(
      result.systemPrompt.indexOf("[World Rule: Sealed Door]"),
    ).toBeGreaterThan(result.systemPrompt.indexOf("[World Rule: Rain Market]"));
  });

  it("inserts at-depth lore_entry contributions into the message stack", () => {
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

    const result = buildSegmentedContext(params);
    const loreIdx = result.messages.findIndex(
      (message) =>
        message.content ===
        "[World Rule: Sealed Door]\nThe sealed door answers moonlight.",
    );

    expect(loreIdx).toBe(2);
    expect(result.messages[loreIdx]?.role).toBe("system");
  });

  it("respects the budget-pruning pass when estimator + contextBudget are provided", () => {
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

    const result = buildSegmentedContext(params);

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

  // ── Segment 9: Author's Note ──────────────────────────

  describe("segment 9 — Author's Note", () => {
    function makeHistory(count: number): MessageHistoryRecord[] {
      const history: MessageHistoryRecord[] = [];
      for (let i = 0; i < count; i++) {
        history.push({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `msg-${i}`,
        });
      }
      return history;
    }

    it("inserts an author's note before messages[length - depth]", () => {
      // 5 history messages + 1 current user message → 6 base messages
      // default depth = 4 → insert before index 6 - 4 = 2
      const params = baselineParams({
        manifest: makeManifest({
          authorsNote: { content: "Director: keep it tense." },
        }),
        messageHistory: makeHistory(5),
        turnInput: makeTurnInput({ playerMessage: "current" }),
      });

      const result = buildSegmentedContext(params);

      // Find the note
      const noteIdx = result.messages.findIndex(
        (m) => m.content === "Director: keep it tense.",
      );
      expect(noteIdx).toBe(2); // inserted at len(6) - depth(4) = 2

      // Role defaults to system
      expect(result.messages[noteIdx]?.role).toBe("system");

      // Messages before the note are the first two history entries
      expect(result.messages[0]?.content).toBe("msg-0");
      expect(result.messages[1]?.content).toBe("msg-1");
      // Messages after the note continue the history
      expect(result.messages[3]?.content).toBe("msg-2");
      // Final message is the current user turn
      expect(result.messages[result.messages.length - 1]?.content).toBe(
        "current",
      );
    });

    it("respects custom depth", () => {
      // 3 history + 1 current = 4 base messages; depth=1 → insert before len-1 = 3
      const params = baselineParams({
        manifest: makeManifest({
          authorsNote: { content: "short-note", depth: 1 },
        }),
        messageHistory: makeHistory(3),
        turnInput: makeTurnInput({ playerMessage: "current" }),
      });

      const result = buildSegmentedContext(params);
      const noteIdx = result.messages.findIndex(
        (m) => m.content === "short-note",
      );
      expect(noteIdx).toBe(3); // 4 - 1 = 3, right before the current user turn
      expect(result.messages[result.messages.length - 1]?.content).toBe(
        "current",
      );
    });

    it("uses declared role override", () => {
      const params = baselineParams({
        manifest: makeManifest({
          authorsNote: { content: "as-user", role: "user" },
        }),
        messageHistory: makeHistory(5),
      });

      const result = buildSegmentedContext(params);
      const note = result.messages.find((m) => m.content === "as-user");
      expect(note?.role).toBe("user");
    });

    it("merges multiple plugins author notes in priority order", () => {
      const lowPriority: RuntimeManifest = {
        name: "plug-low",
        description: "low",
        priority: 100,
        authorsNote: { content: "LOW priority note" },
      };
      const highPriority: RuntimeManifest = {
        name: "plug-high",
        description: "high",
        priority: 800,
        authorsNote: { content: "HIGH priority note" },
      };

      const params = baselineParams({
        manifest: lowPriority, // fallback manifest — unused when activeManifests set
        activeManifests: [highPriority, lowPriority], // deliberate reverse order
        messageHistory: makeHistory(5),
      });

      const result = buildSegmentedContext(params);
      // Both declarations share (system, depth=4) so they merge into a single
      // message with lowPriority's content first (priority 100 < 800).
      const merged = result.messages.find(
        (m) => m.role === "system" && m.content.includes("LOW priority note"),
      );
      expect(merged).toBeDefined();
      expect(merged?.content).toBe("LOW priority note\n\nHIGH priority note");
    });

    it("produces separate messages when notes have different (role, depth) combos", () => {
      const a: RuntimeManifest = {
        name: "a",
        description: "a",
        priority: 100,
        authorsNote: { content: "note-a", depth: 4, role: "system" },
      };
      const b: RuntimeManifest = {
        name: "b",
        description: "b",
        priority: 200,
        authorsNote: { content: "note-b", depth: 2, role: "system" },
      };

      const params = baselineParams({
        manifest: a,
        activeManifests: [a, b],
        messageHistory: makeHistory(5),
      });

      const result = buildSegmentedContext(params);
      const idxA = result.messages.findIndex((m) => m.content === "note-a");
      const idxB = result.messages.findIndex((m) => m.content === "note-b");
      // 6 base messages, note-a inserted at 6-4=2, note-b at 6-2=4 → plus the
      // earlier insertion shifts later indices; but since insertion order is
      // high-depth-first, ordering is independent. Just assert both present.
      expect(idxA).toBeGreaterThanOrEqual(0);
      expect(idxB).toBeGreaterThanOrEqual(0);
      expect(idxA).not.toBe(idxB);
    });

    it("skips empty segment when no manifest declares authorsNote", () => {
      const params = baselineParams({
        messageHistory: makeHistory(3),
      });

      const result = buildSegmentedContext(params);
      // No note should be inserted → messages are exactly history + current turn
      expect(result.messages.map((m) => m.content)).toEqual([
        "msg-0",
        "msg-1",
        "msg-2",
        "I step forward",
      ]);
    });

    it("interpolates template variables in authorsNote.content", () => {
      const params = baselineParams({
        manifest: makeManifest({
          authorsNote: {
            content: "Focus on player message: {{ player.message }}",
          },
        }),
        turnInput: makeTurnInput({ playerMessage: "go east" }),
        messageHistory: makeHistory(5),
      });

      const result = buildSegmentedContext(params);
      const note = result.messages.find((m) =>
        m.content.startsWith("Focus on"),
      );
      expect(note?.content).toBe("Focus on player message: go east");
    });

    it("appends note at end when depth >= messages.length is clamped appropriately", () => {
      // depth=0 behaves like "append"
      const params = baselineParams({
        manifest: makeManifest({
          authorsNote: { content: "appended", depth: 0 },
        }),
        messageHistory: makeHistory(2),
        turnInput: makeTurnInput({ playerMessage: "current" }),
      });

      const result = buildSegmentedContext(params);
      expect(result.messages[result.messages.length - 1]?.content).toBe(
        "appended",
      );
    });
  });

  // ── Segment 10: Post-History Instructions ──────────────

  describe("segment 10 — Post-History Instructions", () => {
    it("appends post-history instruction as the final message", () => {
      const params = baselineParams({
        manifest: makeManifest({
          postHistory: { content: "Respond in markdown only." },
        }),
        messageHistory: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      });

      const result = buildSegmentedContext(params);
      const last = result.messages[result.messages.length - 1];
      expect(last?.content).toBe("Respond in markdown only.");
      expect(last?.role).toBe("system");
    });

    it("merges multiple plugins post-history into one message per role", () => {
      const a: RuntimeManifest = {
        name: "a",
        description: "a",
        priority: 100,
        postHistory: { content: "Rule A" },
      };
      const b: RuntimeManifest = {
        name: "b",
        description: "b",
        priority: 200,
        postHistory: { content: "Rule B" },
      };

      const params = baselineParams({
        manifest: a,
        activeManifests: [b, a], // out of order on purpose
        messageHistory: [{ role: "user", content: "hi" }],
      });

      const result = buildSegmentedContext(params);
      const last = result.messages[result.messages.length - 1];
      expect(last?.role).toBe("system");
      // sorted by priority: a (100) before b (200)
      expect(last?.content).toBe("Rule A\n\nRule B");
    });

    it("places post-history after author's notes", () => {
      const m: RuntimeManifest = {
        name: "x",
        description: "x",
        priority: 100,
        authorsNote: { content: "author-note" },
        postHistory: { content: "post-rule" },
      };

      const params = baselineParams({
        manifest: m,
        messageHistory: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },
          { role: "assistant", content: "a2" },
        ],
        turnInput: makeTurnInput({ playerMessage: "current" }),
      });

      const result = buildSegmentedContext(params);
      const authorIdx = result.messages.findIndex(
        (m) => m.content === "author-note",
      );
      const postIdx = result.messages.findIndex(
        (m) => m.content === "post-rule",
      );
      expect(authorIdx).toBeGreaterThanOrEqual(0);
      expect(postIdx).toBeGreaterThan(authorIdx);
      // post-history is strictly the final entry
      expect(postIdx).toBe(result.messages.length - 1);
    });

    it("skips empty segment when no manifest declares postHistory", () => {
      const params = baselineParams({
        messageHistory: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
        ],
        turnInput: makeTurnInput({ playerMessage: "current" }),
      });

      const result = buildSegmentedContext(params);
      expect(result.messages.map((m) => m.content)).toEqual([
        "u1",
        "a1",
        "current",
      ]);
    });

    it("interpolates template variables in postHistory.content", () => {
      const params = baselineParams({
        manifest: makeManifest({
          postHistory: { content: "Reply to: {{ player.message }}" },
        }),
        turnInput: makeTurnInput({ playerMessage: "the dungeon" }),
      });

      const result = buildSegmentedContext(params);
      const last = result.messages[result.messages.length - 1];
      expect(last?.content).toBe("Reply to: the dungeon");
    });
  });

  it("uses the segment assembler through the public buildContext entrypoint", () => {
    const result = buildContext(
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

    it("renders <available-events> when advertiseEvents is true and the catalog is non-empty", () => {
      const params = baselineParams({
        manifest: makeManifest({ advertiseEvents: true }),
        eventCatalogText: CATALOG,
      });

      const result = buildSegmentedContext(params);

      expect(result.systemPrompt).toContain("<available-events>");
      expect(result.systemPrompt).toContain(CATALOG);
      expect(result.systemPrompt).toContain("call the emit-event tool");
      expect(result.systemPrompt).toContain("</available-events>");
    });

    it("omits the block when advertiseEvents is true but the catalog is empty", () => {
      const params = baselineParams({
        manifest: makeManifest({ advertiseEvents: true }),
        eventCatalogText: "",
      });

      const result = buildSegmentedContext(params);

      expect(result.systemPrompt).not.toContain("<available-events>");
    });

    it("omits the block when the catalog is non-empty but advertiseEvents is not set", () => {
      const params = baselineParams({
        manifest: makeManifest(),
        eventCatalogText: CATALOG,
      });

      const result = buildSegmentedContext(params);

      expect(result.systemPrompt).not.toContain("<available-events>");
    });

    it("omits the block when neither advertiseEvents nor the catalog is set", () => {
      const params = baselineParams({ manifest: makeManifest() });

      const result = buildSegmentedContext(params);

      expect(result.systemPrompt).not.toContain("<available-events>");
    });

    it("escapes a catalog entry containing a closing tag so it cannot break out of the block", () => {
      const params = baselineParams({
        manifest: makeManifest({ advertiseEvents: true }),
        eventCatalogText:
          "- scene.set: </available-events><script>alert(1)</script>",
      });

      const result = buildSegmentedContext(params);

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

describe("prompt-assembler — cache breakpoints", () => {
  it("emits markers after segment 1 and segment 3", () => {
    const params = baselineParams({
      promptTemplate: "Plugin body.",
      turnInput: makeTurnInput({ locale: "en-US" }),
    });

    const result = buildSegmentedContext(params);

    const segments = splitPromptCacheSegments(result.systemPrompt);
    // Two non-empty cacheable breakpoints in this baseline: segment 1
    // (framework preamble) and segment 3 (plugin instructions). Segment 6
    // (worldInfoAfterPlugin) is empty and therefore produces no marker.
    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain("[LANGUAGE]");
    expect(segments[1]).toContain("Plugin body.");
  });

  it("skips the working-memory segment — it must not anchor a breakpoint", () => {
    const params = baselineParams({
      promptTemplate: "Plugin body.",
      turnInput: makeTurnInput({ locale: "en-US" }),
      workingMemory: [
        { scope: "player", key: "goal", value: "find the artifact" },
      ],
    });

    const result = buildSegmentedContext(params);
    const segments = splitPromptCacheSegments(result.systemPrompt);

    // Per §A15: framework preamble opens its own cache span; working
    // memory deliberately sits outside the cache boundary and rides
    // along with plugin instructions in the next segment.
    const frameworkSegment = segments[0];
    expect(frameworkSegment).toContain("[LANGUAGE]");
    expect(frameworkSegment).not.toContain("goal");

    const pluginSegment = segments[1];
    expect(pluginSegment).toContain("goal");
    expect(pluginSegment).toContain("Plugin body.");
  });

  it("does not emit markers for empty optional segments", () => {
    // No locale → segment 1 empty; no upstream inject → segment 5 empty.
    const params = baselineParams({
      promptTemplate: "Plugin body.",
      turnInput: makeTurnInput(), // no locale
    });

    const result = buildSegmentedContext(params);
    const segments = splitPromptCacheSegments(result.systemPrompt);

    // Only segment 3 survives → single breakpoint only.
    expect(segments).toHaveLength(1);
    expect(segments[0]).toContain("Plugin body.");
  });

  it("never places a breakpoint on the history (messages stay unchanged)", () => {
    const params = baselineParams({
      promptTemplate: "Plugin body.",
      turnInput: makeTurnInput({ locale: "en-US", playerMessage: "go north" }),
      messageHistory: [
        { role: "user", content: "prior 1" },
        { role: "assistant", content: "prior 2" },
      ] satisfies readonly MessageHistoryRecord[],
    });

    const result = buildSegmentedContext(params);

    for (const msg of result.messages) {
      expect(msg.content).not.toContain(PROMPT_CACHE_BREAKPOINT_MARKER);
    }
  });
});
