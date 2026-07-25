/**
 * Agent-path observe-only normalization cross-check (docs 02 §4).
 *
 * The agent path keeps producing its result unchanged; W4b only runs the same
 * `normalizeHandlerResult` alongside and warns on divergence. Here an agent
 * whose LLM returns a legacy `{ status: "failed" }` envelope must:
 *   - still land as `status: "success"` (behaviour unchanged), and
 *   - emit one observe warn noting the normalizer would classify it differently.
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

describe("agent observe-only normalization cross-check", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it("keeps status success but warns when the normalizer would classify non-success", async () => {
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

    // Behaviour unchanged: the agent result is still success.
    expect(result.runtimeResults[0]?.status).toBe("success");
    // Observe divergence surfaced.
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some((m) => m.includes("agent-obs/rt") && m.includes("observe")),
    ).toBe(true);
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
