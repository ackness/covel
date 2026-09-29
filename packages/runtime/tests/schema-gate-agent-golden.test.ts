/**
 * Golden characterization of the agent runtime output schema gate.
 *
 * These tests are the regression anchor for the agent-specific structured
 * output path.
 *
 * Pinned behaviours (all via `executeTurn` → `executeAgentRuntime`):
 *   1. schema declared + conforming JSON → success, output = parsed envelope.
 *   2. schema declared + non-conforming JSON → failed, schema-validation error.
 *   3. schema declared + plain prose → failed, prose diagnostic.
 *   4. NO schema declared → no validation at all (wrong shape still succeeds).
 *   5. outputKind "story" + schema declared → gate skipped (the gate only runs
 *      for non-story runtimes), so a non-conforming output still succeeds.
 */

import { describe, expect, it, vi } from "vitest";
import type { Proposal, RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { resumeSuspendedRuntime } from "../src/resume/turn-resume.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { tool, getPendingProposals } from "@covel/tools";
import { z } from "zod";
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
  outputContractSchema?: Record<string, unknown>,
): TurnExecutorDeps {
  return {
    loadRuntime: async (m) => ({
      manifest: m,
      promptTemplate: "Return JSON.",
      ...(outputSchema ? { outputSchema } : {}),
      ...(outputContractSchema ? { outputContractSchema } : {}),
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
    const onRuntimeComplete = vi.fn();
    const deps = makeDeps(llm, { ...OBJECT_SCHEMA });
    deps.onRuntimeComplete = onRuntimeComplete;
    const result = await executeTurn(
      input("sess-wrong"),
      [manifest({ output: { schema: "./output.schema.json" } })],
      deps,
    );

    const r = result.runtimeResults[0];
    expect(r?.status).toBe("failed");
    expect(r?.error).toContain("output did not match output.schema");
    expect(r?.error).toContain("must have required property 'prompt'");
    // The non-conforming parsed object is preserved as the failed output.
    expect((r?.output as Record<string, unknown>).wrong).toBe("shape");
    expect(onRuntimeComplete).toHaveBeenCalledOnce();
    expect(onRuntimeComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "test-plugin/schema-runtime",
        pluginId: "test-plugin",
        status: "failed",
        error: expect.stringContaining("output did not match output.schema"),
      }),
    );
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
    // runtime bypasses the JSON schema gate while still requiring story prose.
    const llm = new FixedContentLLM(
      '{"narrativeOutput":"A lamp lights the stairs."}',
    );
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

describe("ordinary and resumed private schema parity", () => {
  it("passes separated effects and completion through ordinary and resumed results", async () => {
    const worldEvent = { id: "founding", description: "The city was founded" };
    const output = {
      name: "Atlas",
      events: [worldEvent],
      notifications: [{ message: "Ready" }],
      preGameDone: true,
    };
    const m = manifest({ outputContract: "world-ir-provider@1" });
    const deps = makeDeps(
      new FixedContentLLM(JSON.stringify(output)),
      undefined,
      {
        type: "object",
        required: ["events", "name"],
        properties: {
          events: { type: "array" },
          name: { type: "string" },
        },
      },
    );
    const ordinary = await executeTurn(input("effect-parity"), [m], deps);
    const resumed = await resumeSuspendedRuntime(
      {
        id: "effect-suspension",
        sessionId: "effect-parity",
        turnId: "effect-parity-turn",
        pluginId: m.pluginId,
        runtimeId: m.name,
        reason: "input",
        resumeSchema: {},
        createdAt: "2026-01-01T00:00:00Z",
        pendingContinuation: {
          messages: [],
          toolCallsSoFar: [],
          pendingProposals: [],
          executionContext: {
            executionId: "previous",
            origin: "manual",
            countPolicy: "none",
          },
        },
      },
      {},
      m,
      deps,
    );
    for (const result of [ordinary.runtimeResults[0], resumed]) {
      expect(result?.status).toBe("success");
      expect(result?.output).toEqual({ name: "Atlas", events: [worldEvent] });
      expect(result?.effects).toEqual({
        notifications: [{ message: "Ready" }],
      });
      expect(result?.completion).toBe("done");
    }
  });

  it.each([null, ""])(
    "rejects empty terminal content (%s), retaining resumed writes and continuation",
    async (content) => {
      const m = manifest({ output: { schema: "output.json" } });
      const store = createMemoryStore();
      const validContent = '{"prompt":"portrait"}';
      let nextContent: string | null = content;
      const deps = makeDeps(
        {
          generate: async () => ({
            content: nextContent,
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 0 },
          }),
        },
        { ...OBJECT_SCHEMA },
      );
      deps.store = store;
      const turnInput = input(`empty-${content === null ? "null" : "string"}`);
      const ordinary = await executeTurn(turnInput, [m], deps);
      expect(ordinary.runtimeResults[0]?.status).toBe("failed");
      expect(ordinary.runtimeResults[0]?.error).toContain(
        "output did not match output.schema",
      );

      const proposal: Proposal = {
        id: "pending-write",
        type: "plugin.data",
        sessionId: turnInput.sessionId,
        turnId: turnInput.turnId,
        source: { pluginId: m.pluginId, runtimeId: m.name },
        payload: { namespace: "audit", key: "committed", value: true },
        timestamp: new Date().toISOString(),
      };
      const suspension = {
        id: "pending-suspension",
        sessionId: turnInput.sessionId,
        turnId: turnInput.turnId,
        pluginId: m.pluginId,
        runtimeId: m.name,
        reason: "input",
        resumeSchema: {},
        createdAt: new Date().toISOString(),
        pendingContinuation: {
          messages: [],
          toolCallsSoFar: [],
          pendingProposals: [proposal],
          executionContext: {
            executionId: "previous",
            origin: "manual" as const,
            countPolicy: "none" as const,
          },
        },
      };
      await store.saveSuspension(suspension);
      const resumed = await resumeSuspendedRuntime(suspension, {}, m, deps);
      expect(resumed.status).toBe("failed");
      expect(resumed.error).toContain("output did not match output.schema");
      expect(getPendingProposals(resumed.output)).toEqual([]);
      await finalizeExecution({
        store,
        sessionId: turnInput.sessionId,
        executionContext: {
          executionId: resumed.runId,
          origin: "resume",
          countPolicy: "none",
        },
        runtimes: [m],
        results: [resumed],
        turnIds: [turnInput.turnId],
      });
      expect(
        await store.getPluginData(
          turnInput.sessionId,
          m.pluginId,
          "audit",
          "committed",
        ),
      ).toBeNull();
      expect(
        (await store.getSuspension(suspension.id))?.resolvedAt,
      ).toBeUndefined();

      nextContent = validContent;
      const retry = await resumeSuspendedRuntime(suspension, {}, m, deps);
      expect(retry.status).toBe("success");
      expect(getPendingProposals(retry.output)).toEqual([proposal]);
    },
  );

  it.each([
    ['{"prompt":"portrait"}', "success"],
    ['{"prompt":17}', "failed"],
    ["plain prose", "failed"],
  ] as const)("uses the same verdict for %s", async (content, status) => {
    const m = manifest({ output: { schema: "output.json" } });
    const deps = makeDeps(new FixedContentLLM(content), { ...OBJECT_SCHEMA });
    const ordinary = await executeTurn(input("schema-parity"), [m], deps);
    const resumed = await resumeSuspendedRuntime(
      {
        id: "suspended",
        sessionId: "schema-parity",
        turnId: "schema-parity-turn",
        pluginId: m.pluginId,
        runtimeId: m.name,
        reason: "input",
        resumeSchema: {},
        createdAt: "2026-01-01T00:00:00Z",
        pendingContinuation: {
          messages: [],
          toolCallsSoFar: [],
          pendingProposals: [],
          executionContext: {
            executionId: "previous",
            origin: "manual",
            countPolicy: "none",
          },
        },
      },
      {},
      m,
      deps,
    );
    expect(ordinary.runtimeResults[0]?.status).toBe(status);
    expect(resumed.status).toBe(status);
    expect(resumed.output).toEqual(ordinary.runtimeResults[0]?.output);
    expect(getPendingProposals(resumed.output)).toEqual([]);
    expect(await deps.store!.listMessages("schema-parity")).toEqual([]);
  });

  it.each([true, false])(
    "validates completing-tool outputs in both entrypoints (valid=%s)",
    async (valid) => {
      const m = manifest({
        output: { schema: "output.json" },
        completeAfterTools: ["complete"],
        requireToolUse: true,
        tools: { plugin: ["complete"] },
      });
      const deps = makeDeps(
        {
          generate: async () => ({
            content: "incidental prose",
            toolCalls: [{ id: "call", name: "complete", arguments: "{}" }],
            finishReason: "tool_calls",
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        },
        { ...OBJECT_SCHEMA },
      );
      const complete = tool({
        name: "complete",
        description: "Return structured data",
        parameters: z.object({}),
        execute: async () =>
          valid
            ? {
                prompt: "portrait",
                interaction: { interactionId: "form-1", type: "form" },
                ui: [{ id: "card-1", type: "form" }],
              }
            : { wrong: true },
      });
      deps.toolExecutor = createToolExecutor({
        findTool: () => complete,
        store: deps.store!,
      });
      const ordinary = await executeTurn(input("tool-parity"), [m], deps);
      const resumed = await resumeSuspendedRuntime(
        {
          id: "suspended",
          sessionId: "tool-parity",
          turnId: "tool-parity-turn",
          pluginId: m.pluginId,
          runtimeId: m.name,
          reason: "input",
          resumeSchema: {},
          createdAt: "2026-01-01T00:00:00Z",
          pendingContinuation: {
            messages: [],
            toolCallsSoFar: [],
            pendingProposals: [],
            executionContext: {
              executionId: "previous",
              origin: "manual",
              countPolicy: "none",
            },
          },
        },
        {},
        m,
        deps,
      );
      expect(
        ordinary.runtimeResults[0]?.status,
        ordinary.runtimeResults[0]?.error,
      ).toBe(valid ? "success" : "failed");
      expect(resumed.status).toBe(ordinary.runtimeResults[0]?.status);
      expect(resumed.output).toEqual(ordinary.runtimeResults[0]?.output);
      if (valid) {
        for (const result of [ordinary.runtimeResults[0], resumed]) {
          expect(result?.output).toEqual({ prompt: "portrait" });
          expect(result?.effects).toEqual({
            interactions: [{ interactionId: "form-1", type: "form" }],
            ui: [{ id: "card-1", type: "form" }],
          });
        }
      }
    },
  );
});
