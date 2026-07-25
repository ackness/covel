/**
 * Golden characterization of the agent runtime output schema gate.
 *
 * The runtime-scheduling redesign will introduce an envelope-v1 result format
 * and, in a later step, move schema enforcement onto a shared path. These
 * tests are the regression anchor: they pin the CURRENT agent behaviour so any
 * refactor that touches the gate has to keep it byte-for-byte identical.
 *
 * Pinned behaviours (all via `executeTurn` → `executeAgentRuntime`):
 *   1. schema declared + conforming JSON → success, output = parsed envelope.
 *   2. schema declared + non-conforming JSON → failed, schema-validation error.
 *   3. schema declared + plain prose → failed, prose diagnostic.
 *   4. NO schema declared → no validation at all (wrong shape still succeeds).
 *   5. outputKind "story" + schema declared → gate skipped (the gate only runs
 *      for non-story runtimes), so a non-conforming output still succeeds.
 */

import { describe, expect, it } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

// Minimal LLM that returns a fixed string as the final content — enough to
// drive the schema gate, which only inspects the parsed final content.
class FixedContentLLM implements LLMAdapter {
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

const OBJECT_SCHEMA = {
  type: "object",
  required: ["prompt"],
  properties: { prompt: { type: "string" } },
} as const;

function manifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: "test-plugin/schema-runtime",
    pluginId: "test-plugin",
    description: "schema runtime",
    stage: "setup",
    runtimeType: "agent",
    trigger: { type: "auto" },
    outputKind: "plugin",
    ...overrides,
  } as RuntimeManifest;
}

function makeDeps(
  llm: LLMAdapter,
  outputSchema?: Record<string, unknown>,
): TurnExecutorDeps {
  return {
    loadRuntime: async (m) => ({
      manifest: m,
      promptTemplate: "Return JSON.",
      ...(outputSchema ? { outputSchema } : {}),
    }),
    llm,
    store: createMemoryStore(),
  };
}

function input(sessionId: string): TurnInput {
  return { sessionId, turnId: `${sessionId}-turn`, playerMessage: "start" };
}

describe("agent schema gate (golden)", () => {
  it("succeeds and returns the parsed envelope when JSON conforms to the schema", async () => {
    const llm = new FixedContentLLM('{"prompt":"a portrait"}');
    const result = await executeTurn(
      input("sess-ok"),
      [manifest({ output: { schema: "./output.schema.json" } })],
      makeDeps(llm, { ...OBJECT_SCHEMA }),
    );

    const r = result.runtimeResults[0];
    expect(r?.status).toBe("success");
    expect((r?.output as Record<string, unknown>).prompt).toBe("a portrait");
  });

  it("fails with a schema-validation error when JSON has the wrong shape", async () => {
    const llm = new FixedContentLLM('{"wrong":"shape"}');
    const result = await executeTurn(
      input("sess-wrong"),
      [manifest({ output: { schema: "./output.schema.json" } })],
      makeDeps(llm, { ...OBJECT_SCHEMA }),
    );

    const r = result.runtimeResults[0];
    expect(r?.status).toBe("failed");
    expect(r?.error).toContain("output did not match output.schema");
    expect(r?.error).toContain("must have required property 'prompt'");
    // The non-conforming parsed object is preserved as the failed output.
    expect((r?.output as Record<string, unknown>).wrong).toBe("shape");
  });

  it("fails with a prose diagnostic when the model returns plain prose", async () => {
    const llm = new FixedContentLLM("just some narrative, not JSON at all");
    const result = await executeTurn(
      input("sess-prose"),
      [manifest({ output: { schema: "./output.schema.json" } })],
      makeDeps(llm, { ...OBJECT_SCHEMA }),
    );

    const r = result.runtimeResults[0];
    expect(r?.status).toBe("failed");
    expect(r?.error).toContain("expected a JSON envelope per output.schema");
    const output = r?.output as Record<string, unknown>;
    expect(output.narrativeOutput).toBe("just some narrative, not JSON at all");
    expect((output.diagnostic as Record<string, unknown>).kind).toBe(
      "schema-validation-prose",
    );
  });

  it("does not validate when no output schema is declared (wrong shape still succeeds)", async () => {
    // Same non-conforming JSON as the failure case, but the runtime declares no
    // schema → `loaded.outputSchema` is undefined → the gate never runs.
    const llm = new FixedContentLLM('{"wrong":"shape"}');
    const result = await executeTurn(
      input("sess-no-schema"),
      [manifest()],
      makeDeps(llm), // no outputSchema
    );

    const r = result.runtimeResults[0];
    expect(r?.status).toBe("success");
    expect((r?.output as Record<string, unknown>).wrong).toBe("shape");
  });

  it("skips the gate for story runtimes even when a schema is declared", async () => {
    // The gate condition is `outputSchema && outputKind !== "story"`. A story
    // runtime with a schema therefore bypasses validation — a non-conforming
    // output still succeeds.
    const llm = new FixedContentLLM('{"wrong":"shape"}');
    const result = await executeTurn(
      input("sess-story"),
      [
        manifest({
          outputKind: "story",
          output: { schema: "./output.schema.json" },
        }),
      ],
      makeDeps(llm, { ...OBJECT_SCHEMA }),
    );

    const r = result.runtimeResults[0];
    expect(r?.status).toBe("success");
  });
});
