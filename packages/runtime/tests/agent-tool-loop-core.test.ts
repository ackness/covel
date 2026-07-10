/**
 * Direct tests for the agent tool-call loop core (`runAgentToolLoop`),
 * instantiated with a minimal fixture — a scripted LLMAdapter, a real
 * ToolExecutor over one test tool, and a recording TurnEmitter. No turn
 * executor, scheduler, or store required (roadmap W2/W3 acceptance:
 * the loop core is independently instantiable and its trace/delta
 * sequences are pinned).
 */

import { describe, it, expect, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { tool, withPendingProposals } from "@covel/tools";
import { z } from "zod";
import { runAgentToolLoop } from "../src/agent-loop/turn-agent-tool-loop.js";
import type { AgentToolLoopCompleted } from "../src/agent-loop/turn-agent-tool-loop.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import type {
  LLMAdapter,
  LLMResponse,
  LLMStreamEvent,
} from "../src/llm/llm-adapter.js";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";

// ── Fixtures ──────────────────────────────────────────────────────

const input: TurnInput = {
  sessionId: "sess-loop",
  turnId: "turn-loop",
  playerMessage: "go",
};

function manifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "plug/loop",
    pluginId: "plug",
    description: "loop core fixture",
    priority: 500,
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
  constructor(private readonly script: LLMResponse[]) {}
  async generate(): Promise<LLMResponse> {
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
}) {
  return (await runAgentToolLoop({
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
    hookPipeline: undefined,
    startTime: Date.now(),
    runId: "run-loop",
  })) as AgentToolLoopCompleted;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("runAgentToolLoop core", () => {
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
          response: prose("Once upon"),
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

  it("does NOT stream for plugin-output runtimes even when onDelta is wired", async () => {
    const streamSpy = vi.fn();
    const llm: LLMAdapter = {
      generate: async () => prose("plugin chatter"),
      stream: streamSpy as never,
    };
    const result = await run({
      llm,
      deps: { toolExecutor: undefined, onDelta: async () => {} },
    });

    expect(streamSpy).not.toHaveBeenCalled();
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
});
