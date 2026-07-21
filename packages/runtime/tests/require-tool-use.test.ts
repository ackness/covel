/**
 * requireToolUse manifest gate: an agent runtime that finishes without ever
 * successfully executing a tool (LLM drifted into free-form prose, zero tool
 * calls) is given one corrective retry — a system message telling it to call
 * its declared tool first. A second bare finish is released with a warn so a
 * stubborn model cannot wedge the runtime. Motivated by deepseek-v4-flash
 * skipping generate-scene-prompts and just continuing the narrative.
 */

import { describe, it, expect, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { createEmitEventTool, type EventDirectoryLike } from "@covel/tools";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

const directory: EventDirectoryLike = {
  listTopics: async () => ["test.ping"],
  validate: async () => ({ ok: true }),
};

async function mainLoopStore(sessionId: string): Promise<DataStore> {
  const store = createMemoryStore();
  await store.appendTurnMessage({
    id: "seed",
    sessionId,
    turnId: "seed-turn",
    sourceType: "player",
    role: "user",
    content: "prior",
    order: 0,
    createdAt: "2024-01-01T00:00:00Z",
  });
  return store;
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "go",
    ...overrides,
  };
}

function manifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "plug/gated",
    pluginId: "plug",
    description: "Must call emit-event",
    priority: 500,
    outputKind: "plugin",
    tools: { builtin: ["emit-event"] },
    trigger: { type: "auto" },
    ...overrides,
  } as RuntimeManifest;
}

function toolExecutor(store: DataStore) {
  return createToolExecutor({
    findTool: (name) =>
      name === "emit-event" ? createEmitEventTool({ directory }) : undefined,
    store,
  });
}

/** Records the messages seen on each generate() call so tests can assert the
 * correction system message was injected. `scriptedToolStep` returns a tool
 * call on that 1-based step; all other steps return bare prose. */
class ScriptedLLM implements LLMAdapter {
  step = 0;
  seenMessages: { role: string; content: unknown }[][] = [];
  constructor(private readonly toolStep: number | null) {}

  async generate(params: {
    messages: readonly { role: string; content: unknown }[];
  }): Promise<LLMResponse> {
    this.step++;
    this.seenMessages.push([...params.messages]);
    if (this.toolStep !== null && this.step === this.toolStep) {
      return {
        content: null,
        toolCalls: [
          {
            id: `tc-${this.step}`,
            name: "emit-event",
            arguments: JSON.stringify({ topic: "test.ping", data: { x: 1 } }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }
    return {
      content: "The corridor stretches on and the story continues.",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

// The correction message is locale-branched like buildFrameworkPreamble:
// zh locales get the Chinese variant, everything else (including no locale)
// gets English.
const CORRECTION = "You finished without calling any tool";
const CORRECTION_ZH = "你没有调用任何工具就结束了";

describe("requireToolUse gate", () => {
  it("injects one correction then succeeds when the retry calls the tool", async () => {
    const store = await mainLoopStore("sess-1");
    const llm = new ScriptedLLM(2); // step 1 prose, step 2 tool call
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({ manifest: m, promptTemplate: "prompt" }),
      llm,
      store,
      toolExecutor: toolExecutor(store),
    };

    const result = await executeTurn(
      makeTurnInput(),
      [manifest({ requireToolUse: true })],
      deps,
      { maxSteps: 5 },
    );

    // Exactly one corrective retry: step 1 (prose) → correction → step 2
    // (tool call) → step 3 (finish). One call more than the ideal 2-call path.
    expect(llm.step).toBe(3);
    // The correction system message reached the second call.
    const secondCallSystems = llm.seenMessages[1]!.filter(
      (m) => m.role === "system",
    );
    expect(
      secondCallSystems.some((m) => String(m.content).includes(CORRECTION)),
    ).toBe(true);

    const res = result.runtimeResults.find((r) => r.runtimeId === "plug/gated");
    expect(res?.status).toBe("success");
    const events = (res?.output as Record<string, unknown> | null)?.events as
      Array<{ topic: string }> | undefined;
    expect(events).toEqual([{ topic: "test.ping", data: { x: 1 } }]);
  });

  it("injects the Chinese correction for zh locales", async () => {
    const store = await mainLoopStore("sess-1");
    const llm = new ScriptedLLM(2);
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({ manifest: m, promptTemplate: "prompt" }),
      llm,
      store,
      toolExecutor: toolExecutor(store),
    };

    await executeTurn(
      makeTurnInput({ locale: "zh-CN" }),
      [manifest({ requireToolUse: true })],
      deps,
      { maxSteps: 5 },
    );

    const secondCallSystems = llm.seenMessages[1]!.filter(
      (m) => m.role === "system",
    );
    expect(
      secondCallSystems.some((m) => String(m.content).includes(CORRECTION_ZH)),
    ).toBe(true);
  });

  it("releases with a warn when the retry still calls no tool", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = await mainLoopStore("sess-2");
      const llm = new ScriptedLLM(null); // every step is bare prose
      const deps: TurnExecutorDeps = {
        loadRuntime: async (m) => ({ manifest: m, promptTemplate: "prompt" }),
        llm,
        store,
        toolExecutor: toolExecutor(store),
      };

      const result = await executeTurn(
        makeTurnInput({ sessionId: "sess-2" }),
        [manifest({ requireToolUse: true })],
        deps,
        { maxSteps: 5 },
      );

      // One correction attempt, then released — not looped to maxSteps.
      expect(llm.step).toBe(2);
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("reason=no-tool-call"),
        ),
      ).toBe(true);
      const res = result.runtimeResults.find(
        (r) => r.runtimeId === "plug/gated",
      );
      expect(res?.status).toBe("success");
    } finally {
      warn.mockRestore();
    }
  });

  it("default (no requireToolUse) finishes on the first bare response", async () => {
    const store = await mainLoopStore("sess-3");
    const llm = new ScriptedLLM(null);
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({ manifest: m, promptTemplate: "prompt" }),
      llm,
      store,
      toolExecutor: toolExecutor(store),
    };

    await executeTurn(
      makeTurnInput({ sessionId: "sess-3" }),
      [manifest()],
      deps,
      { maxSteps: 5 },
    );

    // No retry — bare finish accepted immediately.
    expect(llm.step).toBe(1);
  });
});
