import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type {
  HandlerResult,
  JsonValue,
  LLMAdapter,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { tool } from "@covel/tools";
import { z } from "zod";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  resolveExportBindings,
  resolveInputBindings,
} from "../src/schedule/input-bindings.js";

const base: RuntimeManifest = {
  name: "probe/main",
  pluginId: "probe",
  stage: "post-turn",
  runtimeType: "function",
  outputKind: "plugin",
  trigger: { type: "auto" },
  maxRetries: 0,
};
const llm: LLMAdapter = {
  generate: async () => ({
    content: "complete",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
};
const input = { sessionId: "session", turnId: "turn", playerMessage: "act" };

describe("terminal domain boundaries", () => {
  it.each(["text", "reasoning"] as const)(
    "does not replace %s output after an empty tool_calls terminal",
    async (outputMode) => {
      const store = createMemoryStore();
      const story = {
        ...base,
        name: "probe/story-with-tool",
        runtimeType: "agent" as const,
        stage: "narrative" as const,
        outputKind: "story" as const,
        tools: { plugin: ["lookup"] },
      };
      const lookup = tool({
        name: "lookup",
        description: "Synthetic lookup",
        parameters: z.object({}),
        execute: async () => ({ found: true }),
      });
      const streamedText = "The door is red.";
      const streamedDeltas: string[] = [];
      const generate = vi.fn<LLMAdapter["generate"]>(async () => ({
        content: "The door is blue.",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }));
      const turn = await executeTurn(input, [story], {
        store,
        toolExecutor: createToolExecutor({ findTool: () => lookup, store }),
        onDelta: async (delta) => {
          streamedDeltas.push(JSON.stringify(delta));
        },
        llm: {
          generate,
          stream: async function* () {
            if (outputMode === "text") {
              yield { type: "text-delta" as const, textDelta: streamedText };
            } else {
              yield {
                type: "reasoning-delta" as const,
                reasoningDelta: "The door color was considered.",
              };
            }
            yield { type: "done" as const, finishReason: "tool_calls" };
          },
        },
        loadRuntime: async () => ({
          manifest: story,
          promptTemplate: "Write story",
        }),
      });
      expect(turn.runtimeResults[0]?.status).toBe("failed");
      expect(turn.runtimeResults[0]?.error).toContain(
        "tool_calls but no structured calls",
      );
      expect(generate).not.toHaveBeenCalled();
      if (outputMode === "text") {
        expect(streamedDeltas.join(" ")).toContain(streamedText);
      }
      const committed = await finalizeExecution({
        store,
        sessionId: input.sessionId,
        executionContext: turn.executionContext,
        runtimes: [story],
        results: turn.runtimeResults,
        turnIds: [turn.turnId],
      });
      expect(committed.status).toBe("failed");
      expect(await store.listMessages(input.sessionId)).toEqual([]);
    },
  );

  it("allows one non-stream recovery for a wholly empty tool_calls stream", async () => {
    const store = createMemoryStore();
    const story = {
      ...base,
      name: "probe/empty-story-with-tool",
      runtimeType: "agent" as const,
      stage: "narrative" as const,
      outputKind: "story" as const,
      tools: { plugin: ["lookup"] },
    };
    const lookup = tool({
      name: "lookup",
      description: "Synthetic lookup",
      parameters: z.object({}),
      execute: async () => ({ found: true }),
    });
    const generate = vi.fn<LLMAdapter["generate"]>(async () => ({
      content: "The door is blue.",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const turn = await executeTurn(input, [story], {
      store,
      toolExecutor: createToolExecutor({ findTool: () => lookup, store }),
      onDelta: async () => {},
      llm: {
        generate,
        stream: async function* () {
          yield { type: "done" as const, finishReason: "tool_calls" };
        },
      },
      loadRuntime: async () => ({
        manifest: story,
        promptTemplate: "Write story",
      }),
    });
    expect(turn.runtimeResults[0]?.status).toBe("success");
    expect(turn.runtimeResults[0]?.output).toMatchObject({
      narrativeOutput: "The door is blue.",
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "only successful producers can commit follower writes (rejected=%s)",
    async (reject) => {
      const store = createMemoryStore();
      const producer = { ...base, name: "probe/producer" };
      const follower = {
        ...base,
        name: "probe/follower",
        trigger: { type: "event" as const, topic: "changed" },
      };
      const hooks = createHookPipeline();
      hooks.register({
        id: "review",
        event: "PostRuntime",
        handler: async (_ctx, payload) => {
          const { result } = payload as { result: RuntimeResult };
          return reject && result.runtimeId === producer.name
            ? {
                action: "continue",
                replace: { result: { ...result, status: "failed" } },
              }
            : { action: "continue" };
        },
      });
      const called = vi.fn();
      const turn = await executeTurn(input, [producer, follower], {
        store,
        llm,
        hookPipeline: hooks,
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler: async (ctx) => {
            if (manifest.name === producer.name)
              return {
                outcome: "success",
                value: {},
                effects: { events: [{ topic: "changed", data: {} }] },
              };
            called();
            await ctx.pluginData.set("probe", "ran", true);
            return { outcome: "success", value: {} };
          },
        }),
      });
      const committed = await finalizeExecution({
        store,
        sessionId: input.sessionId,
        executionContext: turn.executionContext,
        runtimes: [producer, follower],
        results: turn.runtimeResults,
        turnIds: [turn.turnId],
      });
      expect(committed.status).toBe("committed");
      expect(called).toHaveBeenCalledTimes(reject ? 0 : 1);
      expect(
        (await store.getPluginData(input.sessionId, "probe", "probe", "ran"))
          ?.value,
      ).toBe(reject ? undefined : true);
    },
  );

  it.each(["generate", "error-terminal", "throw", "eof"])(
    "never commits partial story after %s failure",
    async (mode) => {
      const store = createMemoryStore();
      const story = {
        ...base,
        name: "probe/story",
        runtimeType: "agent" as const,
        stage: "narrative" as const,
        outputKind: "story" as const,
      };
      const partial = "Partial story before provider failure.";
      const generate = vi.fn<LLMAdapter["generate"]>(async () => ({
        content: partial,
        toolCalls: [],
        finishReason: mode === "generate" ? "error" : "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }));
      const adapter: LLMAdapter = {
        generate,
        ...(mode !== "generate"
          ? {
              stream: async function* () {
                yield { type: "text-delta" as const, textDelta: partial };
                if (mode === "throw") throw new Error("fetch failed");
                if (mode === "error-terminal")
                  yield {
                    type: "done" as const,
                    finishReason: "error" as const,
                  };
              },
            }
          : {}),
      };
      const turn = await executeTurn(input, [story], {
        store,
        llm: adapter,
        onDelta: async () => {},
        loadRuntime: async () => ({
          manifest: story,
          promptTemplate: "Write story",
        }),
      });
      expect(turn.runtimeResults[0]?.status).toBe("failed");
      expect(generate).toHaveBeenCalledTimes(mode === "generate" ? 1 : 0);
      const committed = await finalizeExecution({
        store,
        sessionId: input.sessionId,
        executionContext: turn.executionContext,
        runtimes: [story],
        results: turn.runtimeResults,
        turnIds: [turn.turnId],
      });
      expect(committed.status).toBe("failed");
      expect(
        committed.events.some((event) => event.type === "narrative.completed"),
      ).toBe(false);
      expect(
        (await store.listMessages(input.sessionId)).some(
          (message) => message.content === partial,
        ),
      ).toBe(false);
    },
  );
});

const cases: {
  name: string;
  value: JsonValue;
  schema: Record<string, unknown>;
  select?: string;
  selected: JsonValue;
}[] = [
  { name: "scalar", value: 7, schema: { type: "number" }, selected: 7 },
  {
    name: "array",
    value: [1, 2],
    schema: { type: "array", items: { type: "integer" } },
    select: "/1",
    selected: 2,
  },
  {
    name: "strict-object",
    value: { value: 7 },
    schema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
      additionalProperties: false,
    },
    select: "/value",
    selected: 7,
  },
  { name: "null", value: null, schema: { type: "null" }, selected: null },
];

describe("canonical function values", () => {
  it.each(cases)(
    "publishes and consumes $name consistently across turn and committed inputs",
    async ({ value, schema, select, selected }) => {
      const store = createMemoryStore();
      const producer = {
        ...base,
        output: { schema: "value.json", recordAs: "data" },
        outputContract: "data@1",
      };
      const turn = await executeTurn(input, [producer], {
        store,
        llm,
        loadRuntime: async () => ({
          manifest: producer,
          promptTemplate: "",
          outputSchema: schema,
          outputContractSchema: schema,
          handler: async (): Promise<HandlerResult> => ({
            outcome: "success",
            value,
            completion: "done",
            effects: { events: [{ topic: "changed", data: {} }] },
          }),
        }),
      });
      expect(turn.runtimeResults[0]?.status).toBe("success");
      expect(turn.runtimeResults[0]?.completion).toBe("done");
      expect(turn.runtimeResults[0]?.effects?.events).toEqual([
        { topic: "changed", data: {} },
      ]);
      expect(turn.runtimeResults[0]?.canonicalValue).toEqual({ value });
      const binding = {
        from: { runtime: producer.name },
        required: true,
        ...(select ? { select } : {}),
      };
      const current = await resolveInputBindings({
        manifest: { ...base, name: "consumer/main", inputs: { data: binding } },
        activation: { source: "stage", detached: false, payload: null },
        loadProducerSchema: async () => schema,
        completedResults: new Map(
          (
            JSON.parse(JSON.stringify(turn.runtimeResults)) as RuntimeResult[]
          ).map((r) => [r.runtimeId, r]),
        ),
        activeRuntimes: [producer],
        acceptsSchemas: {},
        contractSchemas: { data: schema },
      });
      expect(current.ok).toBe(true);
      if (current.ok) expect(current.slots.data?.value).toEqual(selected);
      const commit = await finalizeExecution({
        store,
        sessionId: input.sessionId,
        executionContext: turn.executionContext,
        runtimes: [producer],
        results: turn.runtimeResults,
        turnIds: [turn.turnId],
        loadOutputSchema: async () => schema,
      });
      expect(commit.status).toBe("committed");
      const exported = await store.getLatestRuntimeExport(
        input.sessionId,
        producer.name,
        "data",
      );
      expect(exported?.value).toEqual(value);
      const committed = await resolveExportBindings({
        consumerRuntimeId: "consumer/main",
        exportBindings: {
          data: {
            kind: "runtime-export",
            name: "data",
            from: binding.from,
            required: true,
            recordAs: "data",
          },
        },
        activeRuntimes: [producer],
        acceptsSchemas: {},
        contractSchemas: { data: schema },
        getFrozenExport: async () => exported,
      });
      expect(committed.ok).toBe(true);
      if (committed.ok) expect(committed.slots.data?.value).toEqual(value);
    },
  );

  it.each(["output-only", "canonical-valid", "canonical-invalid"])(
    "handles PostRuntime %s rewrites without publishing stale values",
    async (mode) => {
      const store = createMemoryStore();
      const producer = {
        ...base,
        output: { schema: "value.json", recordAs: "data" },
      };
      const hookPipeline = createHookPipeline();
      hookPipeline.register({
        id: "rewrite",
        event: "PostRuntime",
        handler: async (_ctx, payload) => {
          const { result } = payload as { result: RuntimeResult };
          return {
            action: "continue",
            replace: {
              result: {
                ...result,
                output: { value: 8 },
                ...(mode !== "output-only"
                  ? {
                      canonicalValue: {
                        value: mode === "canonical-valid" ? 8 : "invalid",
                      },
                    }
                  : {}),
              },
            },
          };
        },
      });
      const schema = { type: "number" };
      const turn = await executeTurn(input, [producer], {
        store,
        llm,
        hookPipeline,
        loadRuntime: async () => ({
          manifest: producer,
          promptTemplate: "",
          outputSchema: schema,
          handler: async () => ({ outcome: "success", value: 7 }),
        }),
      });
      expect(turn.runtimeResults[0]?.status).toBe(
        mode === "canonical-invalid" ? "failed" : "success",
      );
      await finalizeExecution({
        store,
        sessionId: input.sessionId,
        executionContext: turn.executionContext,
        runtimes: [producer],
        results: turn.runtimeResults,
        turnIds: [turn.turnId],
        loadOutputSchema: async () => schema,
      });
      const exported = await store.getLatestRuntimeExport(
        input.sessionId,
        producer.name,
        "data",
      );
      expect(exported?.value).toBe(mode === "canonical-valid" ? 8 : undefined);
    },
  );
});

it("fails public contract output-only rewrites before buffered writes can commit", async () => {
  const store = createMemoryStore();
  const producer = {
    ...base,
    output: { schema: "value.json", recordAs: "data" },
    outputContract: "number@1",
  };
  const schema = { type: "number" };
  const hookPipeline = createHookPipeline();
  hookPipeline.register({
    id: "rewrite-envelope",
    event: "PostRuntime",
    handler: async (_ctx, payload) => {
      const { result } = payload as { result: RuntimeResult };
      return {
        action: "continue",
        replace: { result: { ...result, output: { value: 8 } } },
      };
    },
  });
  const turn = await executeTurn(input, [producer], {
    store,
    llm,
    hookPipeline,
    loadRuntime: async () => ({
      manifest: producer,
      promptTemplate: "",
      outputSchema: schema,
      outputContractSchema: schema,
      handler: async (ctx) => {
        await ctx.pluginData.set("probe", "saved", true);
        return { outcome: "success", value: 7 };
      },
    }),
  });
  expect(turn.runtimeResults[0]).toMatchObject({
    status: "failed",
    error: expect.stringContaining("contract-output-invalid"),
  });
  await finalizeExecution({
    store,
    sessionId: input.sessionId,
    executionContext: turn.executionContext,
    runtimes: [producer],
    results: turn.runtimeResults,
    turnIds: [turn.turnId],
    loadOutputSchema: async () => schema,
  });
  expect(
    await store.getPluginData(input.sessionId, "probe", "probe", "saved"),
  ).toBeNull();
  expect(
    await store.getLatestRuntimeExport(input.sessionId, producer.name, "data"),
  ).toBeNull();
});
