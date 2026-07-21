import { describe, it, expect, afterEach } from "vitest";
import {
  interpolateTemplate,
  buildInjectBlocks,
  buildContext,
} from "@covel/context";
import type { ContextBuildParams, MessageHistoryRecord } from "@covel/context";
import {
  PROMPT_CACHE_BREAKPOINT_MARKER,
  type RuntimeManifest,
  type RuntimeResult,
  type TurnInput,
} from "@covel/shared";

// ── Helpers ─────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return { name: "test-rt", description: "test", priority: 500, ...overrides };
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
    durationMs: 100,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "I attack the dragon",
    ...overrides,
  };
}

// ── interpolateTemplate ─────────────────────────────────────────

describe("interpolateTemplate", () => {
  it("should replace a simple variable", () => {
    const result = interpolateTemplate("Hello {{ player.message }}", {
      player: { message: "hi" },
    });
    expect(result).toBe("Hello hi");
  });

  it("should replace a nested path variable", () => {
    const result = interpolateTemplate(
      "{{ inputs.narrator.main.narrativeOutput }}",
      { inputs: { narrator: { main: { narrativeOutput: "story" } } } },
    );
    expect(result).toBe("story");
  });

  it("should replace a nested variable", () => {
    const result = interpolateTemplate("World: {{ world.name }}", {
      world: { name: "Cloudmere" },
    });
    expect(result).toBe("World: Cloudmere");
  });

  it("should replace a missing variable with empty string", () => {
    const result = interpolateTemplate("{{ missing.var }}", {});
    expect(result).toBe("");
  });

  it("should replace multiple variables in one template", () => {
    const result = interpolateTemplate(
      "{{ player.name }} says {{ player.message }} in {{ session.id }}",
      {
        player: { name: "Alice", message: "hello" },
        session: { id: "sess-1" },
      },
    );
    expect(result).toBe("Alice says hello in sess-1");
  });

  it("should return plain text unchanged when no variables present", () => {
    const result = interpolateTemplate("no variables here", { foo: "bar" });
    expect(result).toBe("no variables here");
  });

  it("should handle variable patterns with extra spaces", () => {
    const result = interpolateTemplate("{{  player.message  }}", {
      player: { message: "works" },
    });
    expect(result).toBe("works");
  });
});

// ── buildInjectBlocks ───────────────────────────────────────────

describe("buildInjectBlocks", () => {
  it("should build a single inject block", () => {
    const params: ContextBuildParams = {
      promptTemplate: "",
      manifest: makeManifest({
        input: {
          inject: [
            {
              kind: "runtime",
              from: "narrator/main",
              field: "narrativeOutput",
              as: "<narrator-output>",
            },
          ],
        },
      }),
      turnInput: makeTurnInput(),
      completedResults: new Map([
        [
          "narrator/main",
          makeRuntimeResult({ output: { narrativeOutput: "the story" } }),
        ],
      ]),
    };

    const result = buildInjectBlocks(params);
    expect(result).toBe("<narrator-output>the story</narrator-output>");
  });

  it("should build multiple inject blocks", () => {
    const params: ContextBuildParams = {
      promptTemplate: "",
      manifest: makeManifest({
        input: {
          inject: [
            {
              kind: "runtime",
              from: "narrator/main",
              field: "narrativeOutput",
              as: "<narrator-output>",
            },
            {
              kind: "runtime",
              from: "combat/engine",
              field: "combatLog",
              as: "<combat-log>",
            },
          ],
        },
      }),
      turnInput: makeTurnInput(),
      completedResults: new Map([
        [
          "narrator/main",
          makeRuntimeResult({ output: { narrativeOutput: "the story" } }),
        ],
        [
          "combat/engine",
          makeRuntimeResult({ output: { combatLog: "hit for 10 damage" } }),
        ],
      ]),
    };

    const result = buildInjectBlocks(params);
    expect(result).toBe(
      "<narrator-output>the story</narrator-output>\n<combat-log>hit for 10 damage</combat-log>",
    );
  });

  it("should return empty string when inject references a missing result", () => {
    const params: ContextBuildParams = {
      promptTemplate: "",
      manifest: makeManifest({
        input: {
          inject: [
            {
              kind: "runtime",
              from: "missing/runtime",
              field: "data",
              as: "<missing>",
            },
          ],
        },
      }),
      turnInput: makeTurnInput(),
      completedResults: new Map(),
    };

    expect(buildInjectBlocks(params)).toBe("");
  });

  it("should return empty string when manifest has no injects", () => {
    const params: ContextBuildParams = {
      promptTemplate: "",
      manifest: makeManifest(),
      turnInput: makeTurnInput(),
      completedResults: new Map(),
    };

    expect(buildInjectBlocks(params)).toBe("");
  });
});

// ── buildContext ─────────────────────────────────────────────────

describe("buildContext", () => {
  it("should assemble full context with inject and interpolation", () => {
    const params: ContextBuildParams = {
      promptTemplate: "You are a narrator.\n{{ player.message }}\n",
      manifest: makeManifest({
        input: {
          inject: [
            {
              kind: "runtime",
              from: "narrator/main",
              field: "narrativeOutput",
              as: "<narrator-output>",
            },
          ],
        },
      }),
      turnInput: makeTurnInput({ playerMessage: "I open the door" }),
      completedResults: new Map([
        [
          "narrator/main",
          makeRuntimeResult({ output: { narrativeOutput: "the story" } }),
        ],
      ]),
    };

    const ctx = buildContext(params);

    expect(ctx.systemPrompt).toContain(
      "<narrator-output>the story</narrator-output>",
    );
    expect(ctx.systemPrompt).toContain("I open the door");
    expect(ctx.messages).toEqual([
      { role: "user", content: "I open the door" },
    ]);
  });

  it("should return raw template as systemPrompt when no inject and no vars", () => {
    const params: ContextBuildParams = {
      promptTemplate: "Plain instructions.",
      manifest: makeManifest(),
      turnInput: makeTurnInput({ playerMessage: "hello" }),
      completedResults: new Map(),
    };

    const ctx = buildContext(params);

    expect(ctx.systemPrompt).toBe(
      `Plain instructions.${PROMPT_CACHE_BREAKPOINT_MARKER}`,
    );
    expect(ctx.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("uses a runtime execution cue when the current player message is empty", () => {
    const params: ContextBuildParams = {
      promptTemplate: "Plain instructions.",
      manifest: makeManifest(),
      turnInput: makeTurnInput({ locale: "zh-CN", playerMessage: "" }),
      completedResults: new Map(),
    };

    const ctx = buildContext(params);

    expect(ctx.messages).toEqual([
      {
        role: "user",
        content: "开始当前游戏回合，并按照系统设定直接给出游戏内结果。",
      },
    ]);
  });

  it("uses a manual runtime cue when a manual trigger has no player message", () => {
    const params: ContextBuildParams = {
      promptTemplate: "Plain instructions.",
      manifest: makeManifest(),
      turnInput: makeTurnInput({
        locale: "zh-CN",
        playerMessage: "",
        manualTrigger: { runtimeId: "dashscope-image-gen/prompt-generator" },
      }),
      completedResults: new Map(),
    };

    const ctx = buildContext(params);

    expect(ctx.messages).toEqual([
      {
        role: "user",
        content:
          "执行当前手动触发的 runtime：dashscope-image-gen/prompt-generator。严格遵循系统提示中的输出格式，产出该 runtime 的结果。",
      },
    ]);
  });

  it("should include message history before current user message", () => {
    const history: MessageHistoryRecord[] = [
      { role: "user", content: "I enter the cave" },
      {
        role: "assistant",
        content: "The cave is dark and damp.",
        name: "narrator",
      },
    ];

    const params: ContextBuildParams = {
      promptTemplate: "You are a narrator.",
      manifest: makeManifest(),
      turnInput: makeTurnInput({ playerMessage: "I look around" }),
      completedResults: new Map(),
      messageHistory: history,
    };

    const ctx = buildContext(params);

    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toEqual({
      role: "user",
      content: "I enter the cave",
    });
    expect(ctx.messages[1]).toEqual({
      role: "assistant",
      content: "The cave is dark and damp.",
      name: "narrator",
    });
    expect(ctx.messages[2]).toEqual({ role: "user", content: "I look around" });
  });

  it("should preserve name field on history messages", () => {
    const history: MessageHistoryRecord[] = [
      { role: "assistant", content: "A story begins.", name: "narrator" },
    ];

    const params: ContextBuildParams = {
      promptTemplate: "Narrator prompt.",
      manifest: makeManifest(),
      turnInput: makeTurnInput({ playerMessage: "continue" }),
      completedResults: new Map(),
      messageHistory: history,
    };

    const ctx = buildContext(params);
    expect(ctx.messages[0]).toEqual({
      role: "assistant",
      content: "A story begins.",
      name: "narrator",
    });
  });

  it("should behave as before when no message history provided", () => {
    const params: ContextBuildParams = {
      promptTemplate: "Instructions.",
      manifest: makeManifest(),
      turnInput: makeTurnInput({ playerMessage: "hello" }),
      completedResults: new Map(),
    };

    const ctx = buildContext(params);
    expect(ctx.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

// ── Summary substitution (S2-T2) ────────────────────────────────

describe("buildContext — summary substitution", () => {
  it("substitutes compacted spans with summary", () => {
    const history: MessageHistoryRecord[] = [
      { role: "user", content: "older message 1", compactedAtTurnId: "sum-1" },
      {
        role: "assistant",
        content: "older reply 1",
        compactedAtTurnId: "sum-1",
      },
      { role: "user", content: "recent message" },
    ];

    const ctx = buildContext({
      promptTemplate: "Template.",
      manifest: makeManifest(),
      turnInput: makeTurnInput({ playerMessage: "current" }),
      completedResults: new Map(),
      messageHistory: history,
      summaries: [
        {
          id: "sum-1",
          content: "The hero defeated the goblin.",
          focusSections: ["narrative"],
        },
      ],
    });

    // Should have: [summary_envelope, recent_user, current_player]
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("The hero defeated the goblin."),
    });
    expect(ctx.messages[1]).toMatchObject({
      role: "user",
      content: "recent message",
    });
    expect(ctx.messages[2]).toMatchObject({ role: "user", content: "current" });
  });

  it("emits summary only once per compactedAtTurnId, even for multiple messages", () => {
    const history: MessageHistoryRecord[] = [
      { role: "user", content: "msg1", compactedAtTurnId: "sum-1" },
      { role: "assistant", content: "msg2", compactedAtTurnId: "sum-1" },
      { role: "user", content: "msg3", compactedAtTurnId: "sum-1" },
    ];

    const ctx = buildContext({
      promptTemplate: "T.",
      manifest: makeManifest(),
      turnInput: makeTurnInput({ playerMessage: "now" }),
      completedResults: new Map(),
      messageHistory: history,
      summaries: [
        { id: "sum-1", content: "All summarized.", focusSections: [] },
      ],
    });

    // Only one summary envelope + the current user message
    const summaryMessages = ctx.messages.filter(
      (m) =>
        typeof m.content === "string" && m.content.includes("All summarized."),
    );
    expect(summaryMessages).toHaveLength(1);
    expect(ctx.messages).toHaveLength(2);
  });
});
