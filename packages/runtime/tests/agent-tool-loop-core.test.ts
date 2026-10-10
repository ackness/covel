/**
 * Direct tests for the agent tool-call loop core (`runAgentToolLoop`),
 * instantiated with a minimal fixture — a scripted LLMAdapter, a real
 * ToolExecutor over one test tool, and a recording TurnEmitter. No turn
 * executor, scheduler, or store required: the loop core is independently
 * instantiable and its trace/delta sequences are pinned.
 */

import { describe, it, expect, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createCharacterTools, tool, withPendingProposals } from "@covel/tools";
import { createMemoryStore } from "@covel/store/memory";
import { z } from "zod";
import { runAgentToolLoop } from "../src/agent-loop/turn-agent-tool-loop.js";
import type { AgentToolLoopCompleted } from "../src/agent-loop/turn-agent-tool-loop.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { promptCacheKeyFor } from "../src/llm/prompt-cache-key.js";
import { TurnAbortedError } from "../src/turn-executor/turn-control.js";
import type {
  LLMAdapter,
  LLMResponse,
  LLMStreamEvent,
} from "../src/llm/llm-adapter.js";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";

// ── Fixtures ──────────────────────────────────────────────────────

const input: TurnInput = {
  origin: "player",
  sessionId: "sess-loop",
  turnId: "turn-loop",
  playerMessage: "go",
};

function manifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "plug/loop",
    pluginId: "plug",
    description: "loop core fixture",
    stage: "narrative",
    outputKind: "plugin",
    trigger: { type: "auto" },
    tools: { plugin: ["mark"] },
    ...overrides,
  } as RuntimeManifest;
}

const loaded = { promptTemplate: "prompt" } as unknown as LoadedRuntime;

const markTool = tool({
  name: "mark",
  description: "records a marker",
  parameters: z.object({ note: z.string() }),
  async execute(args: { note: string }) {
    return withPendingProposals({ _text: `marked:${args.note}` }, [
      {
        type: "plugin.data",
        payload: { namespace: "loop", key: "mark", value: args.note },
      },
    ] as never);
  },
});

function makeExecutor() {
  return createToolExecutor({
    findTool: (name) => (name === "mark" ? markTool : undefined),
  });
}

/** Scripted LLM: returns queued responses in order; repeats the last one. */
class ScriptedLLM implements LLMAdapter {
  calls = 0;
  readonly requests: Parameters<LLMAdapter["generate"]>[0][] = [];
  constructor(private readonly script: LLMResponse[]) {}
  async generate(
    params: Parameters<LLMAdapter["generate"]>[0],
  ): Promise<LLMResponse> {
    this.requests.push(params);
    const r = this.script[Math.min(this.calls, this.script.length - 1)]!;
    this.calls++;
    return r;
  }
}

function prose(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
  id = "tc-1",
): LLMResponse {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    finishReason: "tool_calls",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function recordingEmitter(): { emitter: TurnEmitter; types: string[] } {
  const types: string[] = [];
  const emitter = {
    emit: async (type: string) => {
      types.push(type);
    },
  } as unknown as TurnEmitter;
  return { emitter, types };
}

async function run(opts: {
  llm: LLMAdapter;
  manifest?: RuntimeManifest;
  deps?: Record<string, unknown>;
  maxSteps?: number;
  messages?: { role: string; content: string }[];
  estimator?: (text: string) => number;
  contextBudget?: {
    maxInputTokens: number;
    reservedForResponse?: number;
    protectLastUserTurns?: number;
  };
}) {
  return (await runAgentToolLoop({
    executionContext: {
      executionId: crypto.randomUUID(),
      origin: "manual",
      countPolicy: "none",
    },
    manifest: opts.manifest ?? manifest(),
    input,
    loaded,
    deps: { llm: opts.llm, toolExecutor: makeExecutor(), ...opts.deps },
    maxSteps: opts.maxSteps ?? 5,
    timeoutMs: 10_000,
    messages: (opts.messages ?? [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
    ]) as never,
    ...(opts.estimator && opts.contextBudget
      ? { estimator: opts.estimator, contextBudget: opts.contextBudget }
      : {}),
    hookPipeline: undefined,
    startTime: Date.now(),
    runId: "run-loop",
  })) as AgentToolLoopCompleted;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("runAgentToolLoop core", () => {
  it("passes cancellation into the tool and rejects its late output", async () => {
    const controller = new AbortController();
    const entered = vi.fn();
    const module = tool({
      name: "mark",
      description: "Fixture",
      parameters: z.object({}),
      async execute(_args, context) {
        entered();
        expect(context.signal?.aborted).toBe(false);
        controller.abort();
        expect(context.signal?.aborted).toBe(true);
        return { late: true };
      },
    });
    await expect(
      run({
        llm: new ScriptedLLM([toolCall("mark", {})]),
        deps: {
          turnControl: { signal: controller.signal },
          toolExecutor: createToolExecutor({ findTool: () => module }),
        },
      }),
    ).rejects.toThrow(TurnAbortedError);
    expect(entered).toHaveBeenCalledTimes(1);
  });
  it("bare prose finish: one call, finalContent set, no deltas", async () => {
    const llm = new ScriptedLLM([prose("done story")]);
    const result = await run({ llm });

    expect(llm.calls).toBe(1);
    expect(result.finalContent).toBe("done story");
    expect(result.stoppedWithResponse).toBe(true);
    expect(result.streamDeltaCount).toBe(0);
    expect(result.collectedToolCalls).toHaveLength(0);
  });

  it("tool round: executes tool, collects call + proposals, feeds result back", async () => {
    const llm = new ScriptedLLM([
      toolCall("mark", { note: "alpha" }),
      prose("after tool"),
    ]);
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
    ];
    const result = await run({ llm, messages });

    expect(llm.calls).toBe(2);
    expect(result.finalContent).toBe("after tool");
    expect(result.collectedToolCalls).toHaveLength(1);
    expect(result.collectedToolCalls[0]).toMatchObject({
      toolName: "mark",
      pluginId: "plug",
      runtimeId: "plug/loop",
      input: { note: "alpha" },
    });
    expect(result.pendingProposals).toHaveLength(1);
    expect(result.pendingProposals[0]).toMatchObject({ type: "plugin.data" });
    // Transcript grew: assistant tool-call message + tool result message.
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    expect(messages[3]!.content).toContain("marked:alpha");
  });

  it("re-budgets a grown tool transcript before each LLM call", async () => {
    const llm = new ScriptedLLM([
      toolCall("mark", { note: "x".repeat(3_000) }),
      prose("must not be reached"),
    ]);

    await expect(
      run({
        llm,
        maxSteps: 3,
        estimator: (text) => text.length,
        contextBudget: {
          maxInputTokens: 1_000,
          reservedForResponse: 100,
          protectLastUserTurns: 1,
        },
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "go" },
        ],
      }),
    ).rejects.toThrow(/Context budget exceeded before LLM call/);
    expect(llm.calls).toBe(1);
    expect(llm.requests[0]?.maxOutputTokens).toBe(100);
  });

  it("sends one cache key for every step of a runtime, and another for another runtime", async () => {
    const llm = new ScriptedLLM([
      toolCall("mark", { note: "a" }),
      prose("done"),
    ]);
    await run({ llm });
    const other = new ScriptedLLM([prose("done")]);
    await run({ llm: other, manifest: manifest({ name: "plug/other" }) });

    const key = llm.requests[0]?.promptCacheKey;
    expect(key).toBe(promptCacheKeyFor(input.sessionId, "plug/loop"));
    expect(llm.requests[1]?.promptCacheKey).toBe(key);
    expect(other.requests[0]?.promptCacheKey).not.toBe(key);
    // A hash within OpenAI's 64 characters, with no session ID in it.
    expect(key).toMatch(/^covel-[0-9a-f]{32}$/);
    expect(promptCacheKeyFor("other-session", "plug/loop")).not.toBe(key);
  });

  it("truncates oversized read-tool results while preserving tool-call pairing", async () => {
    const largeReadTool = tool({
      name: "large-read",
      description: "returns a large read-only result",
      parameters: z.object({}),
      async execute() {
        return { _text: `prefix:${"R".repeat(3_000)}:suffix` };
      },
    });
    const executor = createToolExecutor({
      findTool: (name) => (name === "large-read" ? largeReadTool : undefined),
    });
    const llm = new ScriptedLLM([
      toolCall("large-read", {}),
      prose("after compacted result"),
    ]);
    const { emitter, types } = recordingEmitter();

    const result = await run({
      llm,
      manifest: manifest({ tools: { plugin: ["large-read"] } }),
      deps: { toolExecutor: executor, emitter },
      maxSteps: 3,
      estimator: (text) => text.length,
      contextBudget: {
        maxInputTokens: 1_000,
        reservedForResponse: 100,
        protectLastUserTurns: 1,
      },
    });

    expect(result.finalContent).toBe("after compacted result");
    expect(llm.calls).toBe(2);
    const followUpToolMessage = llm.requests[1]!.messages.find(
      (message) => message.role === "tool",
    );
    expect(followUpToolMessage?.content).toContain("prefix:");
    expect(followUpToolMessage?.content).toContain(":suffix");
    expect(followUpToolMessage?.content).toContain("tool result truncated");
    expect(String(followUpToolMessage?.content).length).toBeLessThan(3_000);
    expect(types).toContain("context.pruned");
  });

  it("temporarily truncates a durable summary when fixed per-call input leaves no other pruneable history", async () => {
    const llm = new ScriptedLLM([prose("summary fallback worked")]);
    const { emitter, types } = recordingEmitter();
    const durableSummary =
      `<compacted_history>\n${"older-fact ".repeat(80)}\n</compacted_history>\n` +
      "The block above is durable reference data.";

    const result = await run({
      llm,
      deps: { emitter },
      estimator: (text) => text.length,
      contextBudget: {
        maxInputTokens: 700,
        reservedForResponse: 100,
        protectLastUserTurns: 1,
      },
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: durableSummary },
        { role: "user", content: "current action" },
      ],
    });

    expect(result.finalContent).toBe("summary fallback worked");
    const sentSummary = llm.requests[0]!.messages.find((message) =>
      String(message.content).includes("compacted history truncated"),
    );
    expect(sentSummary).toBeDefined();
    expect(String(sentSummary?.content).length).toBeLessThan(
      durableSummary.length,
    );
    expect(types).toContain("context.pruned");
  });

  it("completeAfterTools avoids a follow-up LLM call after a completing tool", async () => {
    const llm = new ScriptedLLM([
      toolCall("mark", { note: "single-shot" }),
      prose("should never be reached"),
    ]);
    const result = await run({
      llm,
      manifest: manifest({ completeAfterTools: ["mark"] }),
    });

    expect(llm.calls).toBe(1);
    expect(result.stoppedWithResponse).toBe(true);
    expect(result.collectedToolCalls.map((call) => call.toolName)).toEqual([
      "mark",
    ]);
    expect(result.finalContent).toContain("single-shot");
  });

  it("does not complete after an update-character call fails to find its target", async () => {
    const tools = createCharacterTools(createMemoryStore());
    const llm = new ScriptedLLM([
      toolCall("update-character", { id: "missing", fields: { hp: 1 } }),
      prose("Recovered after the failed update"),
    ]);
    const result = await run({
      llm,
      manifest: manifest({
        tools: { builtin: ["update-character"] },
        completeAfterTools: ["update-character"],
      }),
      deps: {
        toolExecutor: createToolExecutor({
          findTool: (name) => tools.find((tool) => tool.name === name),
          getToolSource: () => "builtin",
        }),
      },
    });
    expect(llm.calls).toBe(2);
    expect(result.finalContent).toBe("Recovered after the failed update");
    expect(result.pendingProposals).toEqual([]);
    expect(llm.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: expect.stringContaining("not found"),
        }),
      ]),
    );
  });

  it("runtime-done sentinel: early exit, sentinel stripped from business calls", async () => {
    const doneTool = tool({
      name: "runtime-done",
      description: "declare completion",
      parameters: z.object({}),
      async execute() {
        return { _covelRuntimeDone: true, reason: "done" };
      },
    });
    const executor = createToolExecutor({
      findTool: (name) =>
        name === "mark"
          ? markTool
          : name === "runtime-done"
            ? doneTool
            : undefined,
    });
    const llm = new ScriptedLLM([
      toolCall("mark", { note: "beta" }),
      {
        content: null,
        toolCalls: [{ id: "tc-done", name: "runtime-done", arguments: "{}" }],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      prose("should never be reached"),
    ]);
    const result = await run({
      llm,
      deps: { toolExecutor: executor },
    });

    // Exits right after the runtime-done round — no third LLM call.
    expect(llm.calls).toBe(2);
    expect(result.stoppedWithResponse).toBe(true);
    // Sentinel stripped: only the business tool remains.
    expect(result.collectedToolCalls.map((c) => c.toolName)).toEqual(["mark"]);
    // No prose was produced → JSON envelope over business calls.
    expect(result.finalContent).toContain("mark");
  });

  it("maxSteps bounds the loop even when the LLM keeps calling tools", async () => {
    // Distinct args each round so loop detection does not fire first.
    let n = 0;
    const llm: LLMAdapter = {
      generate: async () => toolCall("mark", { note: `n${n}` }, `tc-${n++}`),
    };
    const m = manifest({ maxSteps: 2 } as Partial<RuntimeManifest>);
    const result = await run({ llm, manifest: m });

    expect(result.collectedToolCalls).toHaveLength(2);
    expect(result.effectiveMaxSteps).toBe(2);
    expect(result.stoppedWithResponse).toBe(false);
  });

  it("streams deltas for story runtimes with identity attached", async () => {
    const seen: { runtimeId: string; pluginId: string; textDelta: string }[] =
      [];
    const llm: LLMAdapter = {
      generate: async () => prose("fallback"),
      stream: async function* (): AsyncIterable<LLMStreamEvent> {
        yield { type: "text-delta", textDelta: "Once " };
        yield { type: "text-delta", textDelta: "upon" };
        yield {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      } as never,
    };
    const m = manifest({ name: "plug/story", outputKind: "story", tools: {} });
    const result = await run({
      llm,
      manifest: m,
      deps: {
        toolExecutor: undefined,
        onDelta: async (d: (typeof seen)[number]) => {
          seen.push(d);
        },
      },
    });

    expect(result.streamDeltaCount).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      runtimeId: "plug/story",
      pluginId: "plug",
      textDelta: "Once ",
    });
    expect(result.finalContent).toBe("Once upon");
  });

  it.each(["error", "abort"])(
    "rejects %s from the malformed-tool-arguments fallback",
    async (failure) => {
      const controller = new AbortController();
      const { emitter, types } = recordingEmitter();
      let calls = 0;
      const llm: LLMAdapter = {
        generate: async () => {
          if (calls++ === 0)
            throw new Error(
              'The "function.arguments" parameter must be in JSON format.',
            );
          if (failure === "abort") controller.abort();
          return {
            ...prose("invalid fallback"),
            finishReason: failure === "error" ? "error" : "stop",
          };
        },
      };
      await expect(
        run({
          llm,
          deps: { emitter, turnControl: { signal: controller.signal } },
        }),
      ).rejects.toThrow();
      expect(calls).toBe(2);
      expect(types.filter((type) => type.startsWith("llm."))).toEqual([
        "llm.calling",
        "llm.responded",
        "llm.calling",
        "llm.responded",
      ]);
    },
  );

  it("streams plugin-output runtimes without forwarding their text to the story", async () => {
    const streamSpy = vi.fn(async function* () {
      yield { type: "text-delta" as const, textDelta: "plugin chatter" };
      yield { type: "done" as const, finishReason: "stop" };
    });
    const onDelta = vi.fn();
    const llm: LLMAdapter = {
      generate: async () => prose("plugin chatter"),
      stream: streamSpy,
    };
    const result = await run({
      llm,
      deps: { toolExecutor: undefined, onDelta },
    });

    expect(streamSpy).toHaveBeenCalledOnce();
    expect(onDelta).not.toHaveBeenCalled();
    expect(result.streamDeltaCount).toBe(0);
    expect(result.finalContent).toBe("plugin chatter");
  });

  it("pins the llm trace sequence: calling → responded per step", async () => {
    const { emitter, types } = recordingEmitter();
    const llm = new ScriptedLLM([
      toolCall("mark", { note: "t" }),
      prose("end"),
    ]);
    await run({ llm, deps: { toolExecutor: makeExecutor(), emitter } });

    const llmEvents = types.filter((t) => t.startsWith("llm."));
    expect(llmEvents).toEqual([
      "llm.calling",
      "llm.responded",
      "llm.calling",
      "llm.responded",
    ]);
    const toolEvents = types.filter((t) => t.startsWith("tool."));
    expect(toolEvents).toEqual(["tool.calling", "tool.completed"]);
  });

  it("lets a story stuck repeating a tool call write its prose without tools", async () => {
    // Seen with the narrator emitting an event no active plugin consumed:
    // throwing here failed the story and with it the whole player turn.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let i = 0;
      const requests: Parameters<LLMAdapter["generate"]>[0][] = [];
      const llm: LLMAdapter = {
        generate: async (params) => {
          requests.push(params);
          return params.tools
            ? toolCall("mark", { note: "same" }, `tc-${i++}`)
            : prose("The fog closes over the pier.");
        },
      };
      const result = await run({
        llm,
        manifest: manifest({ outputKind: "story" }),
        maxSteps: 20,
      });

      expect(result.finalContent).toBe("The fog closes over the pier.");
      expect(requests.at(-1)?.tools).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("injects one perturbation on a repeated identical tool call, then throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const messages = [
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
      ];
      // Same name + args forever → loop detection (default threshold 3).
      let i = 0;
      const llm: LLMAdapter = {
        generate: async () => toolCall("mark", { note: "same" }, `tc-${i++}`),
      };
      await expect(run({ llm, maxSteps: 20, messages })).rejects.toThrow(
        /tool-loop detected/,
      );

      // Exactly one perturbation system hint was injected before giving up.
      const hints = messages.filter(
        (m) =>
          m.role === "system" &&
          m.content.includes("called the same tool repeatedly"),
      );
      expect(hints).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  // ── Player turn control ─────────────────────────────────────

  it("abort: a pre-fired signal rejects with TurnAbortedError before any LLM call", async () => {
    const controller = new AbortController();
    controller.abort();
    const generateSpy = vi.fn(async () => prose("never"));
    await expect(
      run({
        llm: { generate: generateSpy },
        deps: { turnControl: { signal: controller.signal } },
      }),
    ).rejects.toThrow(TurnAbortedError);
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("abort mid-stream: bypasses fallback — no partial narrative survives", async () => {
    const controller = new AbortController();
    const { emitter, types } = recordingEmitter();
    const llm: LLMAdapter = {
      generate: async () => prose("fallback"),
      stream: async function* (): AsyncIterable<LLMStreamEvent> {
        yield { type: "text-delta", textDelta: "Partial " };
        // Player presses stop mid-stream; the provider then dies on its
        // aborted fetch signal, as real adapters do.
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      } as never,
    };
    const m = manifest({ name: "plug/story", outputKind: "story", tools: {} });
    await expect(
      run({
        llm,
        manifest: m,
        deps: {
          toolExecutor: undefined,
          onDelta: async () => {},
          emitter,
          turnControl: { signal: controller.signal },
        },
      }),
    ).rejects.toThrow(TurnAbortedError);
    // Even though the abort short-circuits fallback/retry, the `llm.calling`
    // must still be paired with an `llm.responded` (error) so trace-viewer
    // pairing does not break.
    const llmEvents = types.filter((t) => t.startsWith("llm."));
    expect(llmEvents).toEqual(["llm.calling", "llm.responded"]);
  });

  it("steering: story runtimes merge queued interjections before the next LLM call", async () => {
    const queue: string[] = ["向左走，不要进森林"];
    const seenMessages: { role: string; content: unknown }[][] = [];
    const llm: LLMAdapter = {
      generate: async (params: {
        messages: readonly { role: string; content: unknown }[];
      }) => {
        seenMessages.push([...params.messages]);
        return prose("story goes left");
      },
    } as LLMAdapter;
    const m = manifest({ name: "plug/story", outputKind: "story", tools: {} });
    await run({
      llm,
      manifest: m,
      deps: {
        toolExecutor: undefined,
        turnControl: { drainSteering: () => queue.splice(0) },
      },
    });

    const users = seenMessages[0]!.filter((msg) => msg.role === "user");
    expect(
      users.some((msg) => String(msg.content).includes("不要进森林")),
    ).toBe(true);
    expect(queue).toHaveLength(0);
  });

  it("steering: an interjection that lands during the final response triggers one more step", async () => {
    // Queue is empty at the pre-step drain and fills while the first LLM
    // response is in flight — the single-step story turn the pre-step drain
    // alone would drop.
    const drains: string[][] = [[], ["等等，回头"]];
    const seenMessages: { role: string; content: unknown }[][] = [];
    const llm: LLMAdapter = {
      generate: async (params: {
        messages: readonly { role: string; content: unknown }[];
      }) => {
        seenMessages.push([...params.messages]);
        return prose(seenMessages.length === 1 ? "walks ahead" : "turns back");
      },
    } as LLMAdapter;
    const m = manifest({ name: "plug/story", outputKind: "story", tools: {} });
    const result = await run({
      llm,
      manifest: m,
      deps: {
        toolExecutor: undefined,
        turnControl: { drainSteering: () => drains.shift() ?? [] },
      },
    });

    // Second call sees the pre-steer prose and the interjection.
    expect(seenMessages).toHaveLength(2);
    const second = seenMessages[1]!;
    expect(
      second.some(
        (msg) =>
          msg.role === "assistant" &&
          String(msg.content).includes("walks ahead"),
      ),
    ).toBe(true);
    expect(
      second.some(
        (msg) =>
          msg.role === "user" && String(msg.content).includes("等等，回头"),
      ),
    ).toBe(true);
    // Both prose chunks survive into finalContent.
    expect(result.finalContent).toBe("walks ahead\n\nturns back");
  });

  it("steering: an interjection keeps the player's own message under the budget's protection", async () => {
    // Both are user messages of the current turn. A budget that protected
    // only the last one dropped the player's message to make room and sent
    // the interjection without what it answers. A call that cannot hold both
    // fails instead.
    const queue = ["等等，回头"];
    const llm = new ScriptedLLM([prose("must not be reached")]);
    await expect(
      run({
        llm,
        manifest: manifest({
          name: "plug/story",
          outputKind: "story",
          tools: {},
        }),
        deps: {
          toolExecutor: undefined,
          turnControl: { drainSteering: () => queue.splice(0) },
        },
        estimator: (text) => text.length,
        contextBudget: { maxInputTokens: 600, reservedForResponse: 100 },
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: `走进森林。${"x".repeat(600)}` },
        ],
      }),
    ).rejects.toThrow(/Context budget exceeded before LLM call/);
    expect(llm.calls).toBe(0);
  });

  it("steering: plugin runtimes never see interjections", async () => {
    const drain = vi.fn(() => ["should not appear"]);
    const seenMessages: { role: string; content: unknown }[][] = [];
    const llm: LLMAdapter = {
      generate: async (params: {
        messages: readonly { role: string; content: unknown }[];
      }) => {
        seenMessages.push([...params.messages]);
        return prose("plugin output");
      },
    } as LLMAdapter;
    await run({
      llm,
      deps: {
        toolExecutor: undefined,
        turnControl: { drainSteering: drain },
      },
    });

    expect(drain).not.toHaveBeenCalled();
    expect(
      seenMessages[0]!.some((msg) =>
        String(msg.content).includes("should not appear"),
      ),
    ).toBe(false);
  });
});
