/**
 * Agent structured output remains independent from function HandlerResult.
 *
 * Agent output is interpreted through its own structured-output path; business
 * fields named `status` do not change the kernel execution status.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

class JsonLLM implements LLMAdapter {
  constructor(private readonly content: string) {}
  async generate(): Promise<LLMResponse> {
    return {
      content: this.content,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

const agentManifest: RuntimeManifest = {
  name: "agent-obs/rt",
  pluginId: "agent-obs",
  description: "agent observe cross-check",
  stage: "narrative",
  outputKind: "plugin",
  trigger: { type: "auto" },
} as RuntimeManifest;

function input(sessionId: string): TurnInput {
  return { sessionId, turnId: `${sessionId}-t`, playerMessage: "hi" };
}

describe("agent structured output", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it("does not treat a business status field as function outcome", async () => {
    const loaded: LoadedRuntime = {
      manifest: agentManifest,
      promptTemplate: "respond",
    };
    const deps = {
      loadRuntime: async () => loaded,
      llm: new JsonLLM(JSON.stringify({ status: "failed", error: "x" })),
      store: createMemoryStore(),
    } as unknown as TurnExecutorDeps;

    const result = await executeTurn(
      input("sess-agent-obs"),
      [agentManifest],
      deps,
    );

    expect(result.runtimeResults[0]?.status).toBe("success");
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("observe"))).toBe(false);
  });

  it("does not warn for a plain success agent output", async () => {
    const loaded: LoadedRuntime = {
      manifest: agentManifest,
      promptTemplate: "respond",
    };
    const deps = {
      loadRuntime: async () => loaded,
      llm: new JsonLLM(JSON.stringify({ narrativeOutput: "hello" })),
      store: createMemoryStore(),
    } as unknown as TurnExecutorDeps;

    const result = await executeTurn(
      input("sess-agent-ok"),
      [agentManifest],
      deps,
    );

    expect(result.runtimeResults[0]?.status).toBe("success");
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("observe"))).toBe(false);
  });
});
