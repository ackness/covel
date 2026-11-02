import { suspendedLoopState, toolCall } from "./_helpers/agent-loop-fixture.js";
/** Agent submissions and resumed outputs use the same frozen schema gate. */

import { describe, expect, it, vi } from "vitest";
import type { Proposal, RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { resumeRuntimePipeline } from "../src/resume/turn-resume.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { tool } from "@covel/tools";
import { z } from "zod";
import type { LLMAdapter, LLMResponse } from "@covel/shared";

// Minimal LLM that returns a fixed string as the final content — enough to
// drive the schema gate, which only inspects the parsed final content.
class FixedContentLLM implements LLMAdapter {
  constructor(private readonly content: string) {}
  async generate(): Promise<LLMResponse> {
    return {
      content: null,
      toolCalls: [
        { id: "final", name: "submit-output", arguments: this.content },
      ],
      finishReason: "tool_calls" as const,
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
    outputKind: "system",
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
  return {
    origin: "player",
    sessionId,
    turnId: `${sessionId}-turn`,
    playerMessage: "start",
  };
}

describe("agent schema gate (golden)", () => {
  it("succeeds and returns the parsed envelope when JSON conforms to the schema", async () => {
    const llm = new FixedContentLLM('{"prompt":"a portrait"}');
    const result = await runTurnPipeline(
      input("sess-ok"),
      [manifest({ output: { schema: "./output.schema.json" } })],
      makeDeps(llm, { ...OBJECT_SCHEMA }),
    );

    const r = result.runtimeResults[0];
    expect(r?.status, r?.error).toBe("success");
    expect((r!.output as Record<string, unknown>).prompt).toBe("a portrait");
  });

  it("fails with a schema-validation error when JSON has the wrong shape", async () => {
    const llm = new FixedContentLLM('{"wrong":"shape"}');
    const onRuntimeComplete = vi.fn();
    const deps: TurnExecutorDeps = {
      ...makeDeps(llm, { ...OBJECT_SCHEMA }),
      onRuntimeComplete,
    };
    const result = await runTurnPipeline(
      input("sess-wrong"),
      [manifest({ output: { schema: "./output.schema.json" } })],
      deps,
    );

    const r = result.runtimeResults[0];
    expect(r?.status, r?.error).toBe("failed");
    expect(r?.error).toContain("invalid-output");
    expect(JSON.stringify(r?.toolCalls)).toContain("prompt");
    // The non-conforming parsed object is preserved as the failed output.
    expect(r?.output).toBeNull();
    expect(onRuntimeComplete).toHaveBeenCalledOnce();
    expect(onRuntimeComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "test-plugin/schema-runtime",
        pluginId: "test-plugin",
        status: "failed",
        error: expect.stringContaining("invalid-output"),
      }),
    );
  });

  it("fails with a prose diagnostic when the model returns plain prose", async () => {
    const llm = new FixedContentLLM("just some narrative, not JSON at all");
    const result = await runTurnPipeline(
      input("sess-prose"),
      [manifest({ output: { schema: "./output.schema.json" } })],
      makeDeps(llm, { ...OBJECT_SCHEMA }),
    );

    const r = result.runtimeResults[0];
    expect(r?.status, r?.error).toBe("failed");
    expect(r?.error).toContain("invalid-json");
    expect(r?.output).toBeNull();
  });

  it("does not validate when no output schema is declared (wrong shape still succeeds)", async () => {
    // Same non-conforming JSON as the failure case, but the runtime declares no
    // schema → `loaded.outputSchema` is undefined → the gate never runs.
    const llm = new FixedContentLLM('{"wrong":"shape"}');
    const result = await runTurnPipeline(
      input("sess-no-schema"),
      [manifest()],
      makeDeps(llm), // no outputSchema
    );

    const r = result.runtimeResults[0];
    expect(r?.status, r?.error).toBe("success");
    expect((r!.output as Record<string, unknown>).wrong).toBe("shape");
  });

  it("applies the declared schema to story runtimes", async () => {
    const llm = new FixedContentLLM(
      '{"narrativeOutput":"A lamp lights the stairs."}',
    );
    const result = await runTurnPipeline(
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
    expect(r?.status, r?.error).toBe("failed");
    expect(r?.output).toBeNull();
  });
});

describe("ordinary and resumed private schema parity", () => {
  it("passes the business value and completion, and no model-written effect, through ordinary and resumed results", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    const ordinary = await runTurnPipeline(input("effect-parity"), [m], deps);
    const resumed = await resumeRuntimePipeline(
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
          loop: suspendedLoopState(
            m,
            m.output ? { ...OBJECT_SCHEMA } : undefined,
            !m.output
              ? {
                  type: "object",
                  required: ["events", "name"],
                  properties: {
                    events: { type: "array" },
                    name: { type: "string" },
                  },
                }
              : undefined,
          ),
          lifecycle: { runId: "suspended-run", progressRunId: "suspended-run" },
          readScopes: [],
          takenUnder: { playerTurns: 0, pluginVersion: "0.0.0", writes: [] },
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
      expect(result?.status, result?.error).toBe("success");
      expect(result?.output).toEqual({ name: "Atlas", events: [worldEvent] });
      expect(result?.effects).toBeUndefined();
      expect(result?.completion).toBe("done");
    }
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it.each([null, ""])(
    "rejects empty terminal content (%s), retaining resumed writes and continuation",
    async (content) => {
      const m = manifest({ output: { schema: "output.json" } });
      const store = createMemoryStore();
      const validContent = '{"prompt":"portrait"}';
      let nextContent: string | null = content;
      const deps: TurnExecutorDeps = {
        ...makeDeps(
          {
            generate: async () => ({
              content: null,
              toolCalls: [
                {
                  id: "final",
                  name: "submit-output",
                  arguments: nextContent ?? "",
                },
              ],
              finishReason: "tool_calls" as const,
              usage: { inputTokens: 1, outputTokens: 0 },
            }),
          },
          { ...OBJECT_SCHEMA },
        ),
        store,
      };
      const turnInput = input(`empty-${content === null ? "null" : "string"}`);
      const ordinary = await runTurnPipeline(turnInput, [m], deps);
      expect(ordinary.runtimeResults[0]?.status).toBe("failed");
      expect(ordinary.runtimeResults[0]?.error).toContain("invalid-json");

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
          loop: suspendedLoopState(
            m,
            m.output ? { ...OBJECT_SCHEMA } : undefined,
            !m.output
              ? {
                  type: "object",
                  required: ["events", "name"],
                  properties: {
                    events: { type: "array" },
                    name: { type: "string" },
                  },
                }
              : undefined,
          ),
          lifecycle: { runId: "suspended-run", progressRunId: "suspended-run" },
          readScopes: [],
          takenUnder: { playerTurns: 0, pluginVersion: "0.0.0", writes: [] },
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
      const resumed = await resumeRuntimePipeline(suspension, {}, m, deps);
      expect(resumed.status, resumed?.error).toBe("failed");
      expect(resumed.error).toContain("invalid-json");
      expect(resumed.pendingProposals ?? []).toEqual([]);
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
      const retry = await resumeRuntimePipeline(suspension, {}, m, deps);
      expect(retry.status, retry?.error).toBe("success");
      expect(retry.pendingProposals).toEqual([proposal]);
    },
  );

  it.each([
    ['{"prompt":"portrait"}', "success"],
    ['{"prompt":17}', "failed"],
    ["plain prose", "failed"],
  ] as const)("uses the same verdict for %s", async (content, status) => {
    const m = manifest({ output: { schema: "output.json" } });
    const deps = makeDeps(new FixedContentLLM(content), { ...OBJECT_SCHEMA });
    const ordinary = await runTurnPipeline(input("schema-parity"), [m], deps);
    const resumed = await resumeRuntimePipeline(
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
          loop: suspendedLoopState(
            m,
            m.output ? { ...OBJECT_SCHEMA } : undefined,
            !m.output
              ? {
                  type: "object",
                  required: ["events", "name"],
                  properties: {
                    events: { type: "array" },
                    name: { type: "string" },
                  },
                }
              : undefined,
          ),
          lifecycle: { runId: "suspended-run", progressRunId: "suspended-run" },
          readScopes: [],
          takenUnder: { playerTurns: 0, pluginVersion: "0.0.0", writes: [] },
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
    expect(resumed.status, resumed?.error).toBe(status);
    expect(resumed.output).toEqual(ordinary.runtimeResults[0]?.output);
    expect(resumed.pendingProposals ?? []).toEqual([]);
    expect(await deps.store!.listMessages("schema-parity")).toEqual([]);
  });

  it.each([true, false])(
    "validates submission after business work in both entrypoints (valid=%s)",
    async (valid) => {
      const m = manifest({
        output: { schema: "output.json" },
        completeAfterTools: ["complete"],
        requireToolUse: true,
        tools: { plugin: ["complete"] },
      });
      const baseDeps = makeDeps(
        {
          generate: async (request) =>
            request.messages.some((message) => message.role === "tool")
              ? toolCall(
                  "submit-output",
                  valid ? { prompt: "portrait" } : { wrong: true },
                )
              : {
                  content: "incidental prose",
                  toolCalls: [
                    { id: "call", name: "complete", arguments: "{}" },
                  ],
                  finishReason: "tool_calls" as const,
                  usage: { inputTokens: 1, outputTokens: 1 },
                },
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
                ui: [
                  {
                    parts: [
                      {
                        id: "card-1",
                        type: "form",
                        status: "success",
                        content: {},
                      },
                    ],
                  },
                ],
              }
            : { wrong: true },
      });
      const deps: TurnExecutorDeps = {
        ...baseDeps,
        toolExecutor: createToolExecutor({
          findTool: () => complete,
          store: baseDeps.store!,
        }),
      };
      const ordinary = await runTurnPipeline(input("tool-parity"), [m], deps);
      const resumed = await resumeRuntimePipeline(
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
            loop: suspendedLoopState(
              m,
              m.output ? { ...OBJECT_SCHEMA } : undefined,
              !m.output
                ? {
                    type: "object",
                    required: ["events", "name"],
                    properties: {
                      events: { type: "array" },
                      name: { type: "string" },
                    },
                  }
                : undefined,
            ),
            lifecycle: {
              runId: "suspended-run",
              progressRunId: "suspended-run",
            },
            readScopes: [],
            takenUnder: { playerTurns: 0, pluginVersion: "0.0.0", writes: [] },
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
      expect(resumed.status, resumed?.error).toBe(
        ordinary.runtimeResults[0]?.status,
      );
      expect(resumed.output).toEqual(ordinary.runtimeResults[0]?.output);
      if (valid) {
        for (const result of [ordinary.runtimeResults[0], resumed]) {
          expect(result?.output).toEqual({ prompt: "portrait" });
          expect(result?.effects).toEqual({
            interactions: [{ interactionId: "form-1", type: "form" }],
            ui: [
              {
                parts: [
                  {
                    id: "card-1",
                    type: "form",
                    status: "success",
                    content: {},
                  },
                ],
              },
            ],
          });
        }
      }
    },
  );
});
