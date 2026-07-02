/**
 * Integration test for the unified event emission layer's runtime leg (plan
 * task 3): an agent runtime calls the `emit-event` builtin tool, the tool
 * loop threads the emitted event into `output.events` at finalize, the
 * same-turn event fan-out (`runEventChain`) triggers the subscribing
 * function runtime, and the commit-proposal pipeline sees exactly one
 * `event.emit` proposal — proving `emit-event` never double-emits via a
 * pendingProposal (see packages/tools/src/builtin/emit-event.ts).
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import {
  createEmitEventTool,
  getPendingProposals,
  type EventDirectoryLike,
} from "@covel/tools";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { normalizeOutput } from "../src/commit/session-output-normalizer.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";
import type { FunctionHandlerContext } from "@covel/plugin-loader";

// Static directory stub — only "test.ping" is declared. Mirrors the shape
// the server's session event directory (task 4) will implement.
const directory: EventDirectoryLike = {
  listTopics: async () => ["test.ping"],
  validate: async () => ({ ok: true }),
};

// Scripted two-step MockLLM: step 1 calls emit-event, step 2 returns final text.
class ScriptedLLM implements LLMAdapter {
  private step = 0;

  async generate(): Promise<LLMResponse> {
    this.step++;
    if (this.step === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: "tc-1",
            name: "emit-event",
            arguments: JSON.stringify({
              topic: "test.ping",
              data: { x: 1 },
            }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }
    return {
      content: "test.ping emitted, done.",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

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
    playerMessage: "emit a ping",
    ...overrides,
  };
}

describe("emit-event: tool-loop accumulation + finalize merge into output.events", () => {
  it("fans out to the same-turn subscriber and commits exactly one event.emit proposal", async () => {
    const emitterManifest: RuntimeManifest = {
      name: "plug/emitter",
      pluginId: "plug",
      description: "Emits domain events via emit-event",
      priority: 500,
      outputKind: "plugin",
      tools: { builtin: ["emit-event"] },
      trigger: { type: "auto" },
    } as RuntimeManifest;

    const followerManifest: RuntimeManifest = {
      name: "plug/follower",
      pluginId: "plug",
      description: "Subscribes to test.ping",
      priority: 600,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "event", topic: "test.ping" },
    } as RuntimeManifest;

    const followerCalls: FunctionHandlerContext[] = [];

    const store = await mainLoopStore("sess-1");
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => {
        if (m.name === "plug/follower") {
          return {
            manifest: m,
            promptTemplate: "",
            handler: async (ctx: FunctionHandlerContext) => {
              followerCalls.push(ctx);
              return { ok: true };
            },
          };
        }
        return {
          manifest: m,
          promptTemplate: "Emit test.ping via emit-event.",
        };
      },
      llm: new ScriptedLLM(),
      getConfig: () => ({}),
      store,
      toolExecutor: createToolExecutor({
        findTool: (name) =>
          name === "emit-event"
            ? createEmitEventTool({ directory })
            : undefined,
        store,
      }),
    };

    const result = await executeTurn(
      makeTurnInput(),
      [emitterManifest, followerManifest],
      deps,
      { maxSteps: 3 },
    );

    const names = result.runtimeResults.map((r) => r.runtimeId);
    expect(names).toContain("plug/emitter");
    expect(names).toContain("plug/follower");

    // Follower saw the emitted event's payload via ctx.triggerEvent.
    const triggerEvent = followerCalls[0]?.triggerEvent as
      | { topic?: string; data?: { x?: number } }
      | undefined;
    expect(triggerEvent?.topic).toBe("test.ping");
    expect(triggerEvent?.data?.x).toBe(1);

    // Emitter's own RuntimeResult carries the event in output.events.
    const emitterResult = result.runtimeResults.find(
      (r) => r.runtimeId === "plug/emitter",
    );
    expect(emitterResult?.status).toBe("success");
    const events = (emitterResult?.output as Record<string, unknown> | null)
      ?.events as Array<{ topic: string; data: unknown }> | undefined;
    expect(events).toEqual([{ topic: "test.ping", data: { x: 1 } }]);

    // Double-emission guard: the commit-proposal computation (mirrors
    // processRuntimeResult) must see exactly one event.emit proposal —
    // emit-event never also returns an event.emit pendingProposal.
    const output = emitterResult!.output as Record<string, unknown>;
    const proposals = normalizeOutput(
      output,
      { pluginId: "plug", runtimeId: "plug/emitter" },
      "turn-1",
      "sess-1",
      "plugin",
    );
    proposals.push(...getPendingProposals(output));
    const eventEmitProposals = proposals.filter((p) => p.type === "event.emit");
    expect(eventEmitProposals).toHaveLength(1);
    expect(eventEmitProposals[0]!.payload).toEqual({
      topic: "test.ping",
      data: { x: 1 },
    });
  });
});

describe("emit-event: segment 5 directory injection (plan task 5)", () => {
  it("threads deps.eventDirectory.catalogText into the system prompt for an advertiseEvents runtime", async () => {
    const emitterManifest: RuntimeManifest = {
      name: "plug/emitter",
      pluginId: "plug",
      description: "Emits domain events via emit-event",
      priority: 500,
      outputKind: "plugin",
      tools: { builtin: ["emit-event"] },
      trigger: { type: "auto" },
      advertiseEvents: true,
    } as RuntimeManifest;

    let capturedSystemPrompt: string | undefined;
    class CapturingLLM implements LLMAdapter {
      async generate(params: {
        messages: readonly { role: string; content: unknown }[];
      }): Promise<LLMResponse> {
        capturedSystemPrompt ??= params.messages.find(
          (m) => m.role === "system",
        )?.content as string | undefined;
        return {
          content: "done.",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
    }

    const store = await mainLoopStore("sess-1");
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "You are a domain-event emitter.",
      }),
      llm: new CapturingLLM(),
      getConfig: () => ({}),
      store,
      toolExecutor: createToolExecutor({
        findTool: (name) =>
          name === "emit-event"
            ? createEmitEventTool({ directory })
            : undefined,
        store,
      }),
      eventDirectory: {
        catalogText: async () =>
          "- test.ping: Ping event (required: x: number)",
      },
    };

    await executeTurn(makeTurnInput(), [emitterManifest], deps, {
      maxSteps: 3,
    });

    expect(capturedSystemPrompt).toContain("<available-events>");
    expect(capturedSystemPrompt).toContain(
      "- test.ping: Ping event (required: x: number)",
    );
  });
});

describe("emit-event: same-turn duplicate topic no-op (plan task 1)", () => {
  it("only produces one event.emit proposal when emit-event is called twice for the same topic", async () => {
    // Three-step script: step 1 and step 2 both call emit-event for
    // "test.ping" (simulating an LLM re-emitting the same fact), step 3
    // returns final text. The tool loop should thread the topic emitted in
    // step 1 into step 2's ToolExecutionContext so emit-event no-ops instead
    // of producing a second emittedEvent.
    class RepeatingLLM implements LLMAdapter {
      private step = 0;

      async generate(): Promise<LLMResponse> {
        this.step++;
        if (this.step <= 2) {
          return {
            content: null,
            toolCalls: [
              {
                id: `tc-${this.step}`,
                name: "emit-event",
                arguments: JSON.stringify({
                  topic: "test.ping",
                  data: { x: this.step },
                }),
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        return {
          content: "done.",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
    }

    const emitterManifest: RuntimeManifest = {
      name: "plug/emitter",
      pluginId: "plug",
      description: "Emits domain events via emit-event",
      priority: 500,
      outputKind: "plugin",
      tools: { builtin: ["emit-event"] },
      trigger: { type: "auto" },
    } as RuntimeManifest;

    const store = await mainLoopStore("sess-1");
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "Emit test.ping via emit-event.",
      }),
      llm: new RepeatingLLM(),
      getConfig: () => ({}),
      store,
      toolExecutor: createToolExecutor({
        findTool: (name) =>
          name === "emit-event"
            ? createEmitEventTool({ directory })
            : undefined,
        store,
      }),
    };

    const result = await executeTurn(makeTurnInput(), [emitterManifest], deps, {
      maxSteps: 4,
    });

    const emitterResult = result.runtimeResults.find(
      (r) => r.runtimeId === "plug/emitter",
    );
    expect(emitterResult?.status).toBe("success");

    // Only the first emit-event call produced an event — output.events has
    // exactly one entry, from step 1's payload.
    const events = (emitterResult?.output as Record<string, unknown> | null)
      ?.events as Array<{ topic: string; data: unknown }> | undefined;
    expect(events).toEqual([{ topic: "test.ping", data: { x: 1 } }]);

    // The second tool call got the "already emitted" no-op hint instead of
    // a second emitted event.
    const secondCall = emitterResult!.toolCalls[1];
    expect((secondCall?.output as { _text?: string })?._text).toContain(
      "already emitted",
    );

    // Exactly one event.emit proposal reaches commit — the duplicate never
    // produced a second one to merge.
    const output = emitterResult!.output as Record<string, unknown>;
    const proposals = normalizeOutput(
      output,
      { pluginId: "plug", runtimeId: "plug/emitter" },
      "turn-1",
      "sess-1",
      "plugin",
    );
    proposals.push(...getPendingProposals(output));
    const eventEmitProposals = proposals.filter((p) => p.type === "event.emit");
    expect(eventEmitProposals).toHaveLength(1);
  });
});
