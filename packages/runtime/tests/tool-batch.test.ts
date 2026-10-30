import { describe, expect, it } from "vitest";
import type { LLMMessage, LLMToolCall } from "@covel/shared";
import {
  closeUnansweredToolCalls,
  cutToolStep,
  runBounded,
} from "../src/agent-loop/tool-batch.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";
import { expectMatchedToolCalls } from "./_helpers/agent-loop-fixture.js";

describe("bounded tool work", () => {
  it("starts in order, caps active work, and retains result order", async () => {
    const started: number[] = [];
    let active = 0;
    let maximum = 0;
    const result = await runBounded(
      Array.from({ length: 10 }, (_, index) => async () => {
        started.push(index);
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, index % 2 ? 1 : 10));
        active--;
        return index;
      }),
      3,
    );
    expect(started).toEqual(Array.from({ length: 10 }, (_, index) => index));
    expect(maximum).toBe(3);
    expect(active).toBe(0);
    expect(result).toEqual(started);
  });

  it("waits for all tasks before rethrowing the first rejection", async () => {
    const settled: number[] = [];
    const first = new Error("first failure");
    const run = runBounded(
      [
        async () => {
          throw first;
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          settled.push(1);
          throw new Error("later failure");
        },
        async () => {
          settled.push(2);
          return 2;
        },
      ],
      2,
    );
    await expect(run).rejects.toBe(first);
    expect(settled).toEqual([2, 1]);
  });

  it("accepts an empty batch and rejects an invalid width", async () => {
    expect(await runBounded([], 8)).toEqual([]);
    await expect(runBounded([], 0)).rejects.toThrow(RangeError);
  });
});

const calls: LLMToolCall[] = ["read", "read", "write", "read", "read"].map(
  (name, index) => ({ id: `call-${index}`, name, arguments: "{}" }),
);
const poolable = (call: LLMToolCall) => call.name === "read";

describe("tool steps", () => {
  it("cuts consecutive reads into pools separated by single barriers", () => {
    expect(cutToolStep(calls, 0, poolable)).toEqual({
      kind: "pool",
      indices: [0, 1],
    });
    expect(cutToolStep(calls, 2, poolable)).toEqual({
      kind: "barrier",
      indices: [2],
    });
    expect(cutToolStep(calls, 3, poolable)).toEqual({
      kind: "pool",
      indices: [3, 4],
    });
  });

  it("retains refused positions and ends a pool before a rewritten barrier", () => {
    const memo = new Map<number, LLMToolCall | null>([
      [0, null],
      [1, { ...calls[1]!, name: "write" }],
    ]);
    expect(cutToolStep(calls, 0, poolable, memo).indices).toEqual([0]);
    expect(cutToolStep(calls, 1, poolable, memo).kind).toBe("barrier");
    // An original barrier cannot be looked ahead through, even with a memo.
    memo.set(2, { ...calls[2]!, name: "read" });
    expect(
      cutToolStep(calls, 0, poolable, new Map([[2, memo.get(2)!]])).indices,
    ).toEqual([0, 1]);
  });
});

describe("closing unanswered tool calls", () => {
  it("answers exactly the missing calls in model order and is then a no-op", async () => {
    const messages: LLMMessage[] = [
      { role: "assistant", content: "", toolCalls: calls.slice(0, 3) },
      { role: "tool", content: "{}", toolCallId: calls[1]!.id },
    ];
    const emitter = makeEmitterSpy();
    const args = {
      messages,
      assistantMessageIndex: 0,
      reason: "terminated" as const,
      context: {
        sessionId: "session",
        turnId: "turn",
        pluginId: "fixture",
        runtimeId: "fixture/run",
        emitter,
      },
    };
    await closeUnansweredToolCalls(args);
    expect(messages.slice(2).map((message) => message.toolCallId)).toEqual([
      calls[0]!.id,
      calls[2]!.id,
    ]);
    expect(JSON.parse(messages[2]!.content as string).error.code).toBe(
      "cancelled",
    );
    expectMatchedToolCalls(messages);
    await closeUnansweredToolCalls(args);
    expect(messages).toHaveLength(4);
    expect(emitter.events.map((event) => event.type)).toEqual([
      "tool.calling",
      "tool.failed",
      "tool.calling",
      "tool.failed",
    ]);
  });
});
