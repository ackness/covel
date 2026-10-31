import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  OperationRecord,
  RuntimeResult,
  InputSlot,
  LLMMessage,
} from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import { executeTurn } from "../src/execution.js";
import { buildOperationsInput } from "../src/turn-executor/operations-input.js";
import { attachNestedResults } from "../src/turn-executor/nested-results.js";
import { createToolExecutionContext } from "../src/agent-loop/tool-execution-context.js";
import { answer, fixture, input, runtime } from "./operation-fixture.js";

const inject = {
  inject: [{ kind: "kernel", from: "operations@1", name: "operations" }],
} as const;
const record = (
  seq: number,
  status: OperationRecord["status"] = "staged",
): OperationRecord => ({
  id: `operation-${seq}`,
  providerPluginId: "private-provider",
  service: "change",
  invokedBy: { pluginId: "caller", runtimeId: "caller/run" },
  seq,
  status,
  contract: "change@1",
  summary: `Changed ${seq}`,
  request: { amount: seq },
  result: { saved: true },
});
const result = (
  seq: number,
  status: RuntimeResult["status"] = "success",
): RuntimeResult => ({
  pluginId: "caller",
  runtimeId: `caller/${seq}`,
  runId: `run-${seq}`,
  turnId: "turn",
  status,
  output: {},
  toolCalls: [],
  durationMs: 0,
  timestamp: "now",
  operations: [record(seq)],
});

describe("execution operation input", () => {
  it("takes an owned frozen projection of eligible results, including nested calls and excluding seeds", () => {
    const parent = attachNestedResults(result(3), [result(1)]);
    const seed = attachNestedResults(result(4), [result(5)]);
    const discarded = { ...result(6), operations: [record(6, "discarded")] };
    const snapshot = buildOperationsInput(
      new Map(
        [parent, seed, discarded, result(2, "failed")].map((r) => [
          r.runtimeId,
          r,
        ]),
      ),
      new Set([seed]),
    );
    expect(snapshot.operations.map((op) => op.summary)).toEqual([
      "Changed 1",
      "Changed 3",
    ]);
    expect(Object.isFrozen(snapshot.operations[0]?.request)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /operation-|private-provider|caller\/|run-/,
    );
    expect(snapshot.operations[0]).toEqual({
      contract: "change@1",
      summary: "Changed 1",
      request: { amount: 1 },
      result: { saved: true },
    });
  });

  it("binds completed narrative operations for functions and agents while an earlier sibling sees an empty input", async () => {
    const { store, services } = await fixture();
    services.register("provider", {
      name: "change",
      contract: "change@1",
      access: "write",
      input: z.object({ amount: z.number() }),
      output: z.unknown(),
      handler: async ({ amount }, ctx) => {
        await ctx.pluginData.set("values", "amount", amount);
        return { amount };
      },
    });
    const producer = runtime("caller/producer");
    const sibling = runtime("observer/sibling", { input: inject });
    const consumer = runtime("observer/consumer", {
      stage: "post-turn",
      input: inject,
    });
    const agent = runtime("observer/agent", {
      stage: "post-turn",
      runtimeType: "agent",
      outputKind: "story",
      input: inject,
    });
    const seen = new Map<
      string,
      Readonly<Record<string, InputSlot>> | undefined
    >();
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handlers: Record<string, FunctionHandler> = {
      [producer.name]: async (ctx) => {
        await started;
        await ctx.services!.call({
          pluginId: "provider",
          name: "change",
          contract: "change@1",
          input: { amount: 4 },
        });
        return { outcome: "success", value: {} };
      },
      [sibling.name]: async (ctx) => {
        seen.set(sibling.name, ctx.inputs);
        release();
        return { outcome: "success", value: {} };
      },
      [consumer.name]: async (ctx) => {
        seen.set(consumer.name, ctx.inputs);
        return { outcome: "success", value: {} };
      },
    };
    const requests: (readonly LLMMessage[])[] = [];
    try {
      const execution = await executeTurn(
        input,
        [producer, sibling, consumer, agent],
        {
          store,
          services,
          llm: {
            generate: async (request) => {
              requests.push(request.messages);
              return answer();
            },
          },
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate: "Tell the story.",
            handler: handlers[manifest.name],
          }),
        },
      );
      expect(
        execution.commit.results.every((r) => r.status === "success"),
      ).toBe(true);
      expect(seen.get(sibling.name)?.operations).toMatchObject({
        value: { operations: [] },
      });
      expect(seen.get(consumer.name)?.operations).toMatchObject({
        value: {
          operations: [{ contract: "change@1", request: { amount: 4 } }],
        },
      });
      expect(JSON.stringify(requests)).toContain("change@1");
      expect(JSON.stringify(requests)).not.toContain(
        execution.commit.results[0]?.runId,
      );
    } finally {
      await store.close();
    }
  });

  it("does not expose the operation input to tools", () => {
    const scope = createToolExecutionContext(
      {
        sessionId: "session",
        turnId: "turn",
        pluginId: "caller",
        runtimeId: "caller/run",
        inputSlots: {
          operations: {
            cardinality: "one",
            value: { operations: [] },
            source: {
              pluginId: "__kernel",
              runtimeId: "operations@1",
              resultId: "execution",
            },
          },
          ordinary: {
            cardinality: "one",
            value: "hello",
            source: {
              pluginId: "caller",
              runtimeId: "caller/upstream",
              resultId: "run",
            },
          },
        },
      },
      undefined,
    );
    expect(scope.context.inputSlots).not.toHaveProperty("operations");
    expect(scope.context.inputSlots).toHaveProperty("ordinary");
    scope.close();
  });
});
