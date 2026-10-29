/**
 * `step.started` / `step.completed`: order against the `llm.*` and `tool.*`
 * events, payloads, notes, thrown steps, concealment and emitter failures.
 * Events go through a real TurnEmitter over a recording trace store.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SEARCH_TOOLS_TOOL_NAME, tool } from "@covel/tools";
import { createTurnEmitter } from "../src/trace/turn-emitter.js";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  makeExecutor,
  manifest,
  markTool,
  prose,
  queuedLLM,
  runLoop,
  scriptedLLM,
  toolCall,
  type LoopRunOptions,
} from "./_helpers/agent-loop-fixture.js";

interface Row {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function recordingEmitter(concealed: readonly string[] = []): {
  emitter: TurnEmitter;
  rows: Row[];
} {
  const rows: Row[] = [];
  const emitter = createTurnEmitter({
    store: {
      async addTraceEvent(record) {
        rows.push({
          type: record.type,
          payload: record.payload as Record<string, unknown>,
        });
      },
    },
    sessionId: "sess-loop",
    turnId: "turn-loop",
    concealedRuntimeIds: new Set(concealed),
  });
  return { emitter, rows };
}

const stepRows = (rows: readonly Row[]) =>
  rows.filter((row) => row.type.startsWith("step."));

/** Run the loop (or let it throw) and return its trace rows. */
async function traced(
  options: Omit<LoopRunOptions, "deps"> & {
    readonly deps?: Record<string, unknown>;
    readonly concealed?: readonly string[];
  },
): Promise<{ rows: Row[]; error?: unknown }> {
  const { emitter, rows } = recordingEmitter(options.concealed);
  try {
    await runLoop({ ...options, deps: { emitter, ...options.deps } });
    return { rows };
  } catch (error) {
    return { rows, error };
  }
}

function expectOneCompletedPerStarted(rows: readonly Row[]): void {
  const started = stepRows(rows)
    .filter((row) => row.type === "step.started")
    .map((row) => row.payload.step);
  const completed = stepRows(rows)
    .filter((row) => row.type === "step.completed")
    .map((row) => row.payload.step);
  expect(completed).toEqual(started);
  // Strictly alternating: every step closes before the next opens.
  stepRows(rows).forEach((row, index) =>
    expect(row.type).toBe(index % 2 === 0 ? "step.started" : "step.completed"),
  );
}

describe("step events", () => {
  it("orders step events around the model and tool events of each step", async () => {
    const { rows } = await traced({
      llm: queuedLLM([toolCall("mark", { note: "a" }), prose("done")]),
    });
    const sequence = rows
      .filter((row) => /^(step|llm|tool)\./.test(row.type))
      .map((row) =>
        row.type.startsWith("step.")
          ? `${row.type}(${String(row.payload.step)})`
          : row.type,
      );
    expect(sequence).toEqual([
      "step.started(1)",
      "llm.calling",
      "llm.responded",
      "tool.calling",
      "tool.completed",
      "step.completed(1)",
      "step.started(2)",
      "llm.calling",
      "llm.responded",
      "step.completed(2)",
    ]);
    expectOneCompletedPerStarted(rows);
  });

  it("carries identity, usage, finish reason, tool calls, and the stop on the last step only", async () => {
    const { rows } = await traced({
      llm: queuedLLM([toolCall("mark", { note: "a" }), prose("done")]),
    });
    const [started1, completed1, , completed2] = stepRows(rows).map(
      (row) => row.payload,
    );
    expect(started1).toMatchObject({
      runtimeId: "plug/loop",
      pluginId: "plug",
      turnId: "turn-loop",
      runId: "run-loop",
      step: 1,
      maxSteps: 5,
      toolChoice: "auto",
    });
    // The count of the tools the step's request advertised.
    const calling = rows.find((row) => row.type === "llm.calling");
    expect(calling).toBeDefined();
    expect(started1?.toolCount).toBe(
      (calling!.payload.tools as unknown[]).length,
    );
    expect(started1).not.toHaveProperty("finalizer");
    expect(completed1).toMatchObject({
      step: 1,
      finishReason: "tool_calls",
      usage: { inputTokens: 3, outputTokens: 2 },
      toolCalls: [{ name: "mark", success: true }],
      retries: [],
      notes: [],
    });
    expect(completed1).not.toHaveProperty("stopReason");
    expect(typeof completed1?.durationMs).toBe("number");
    expect(completed2).toMatchObject({
      step: 2,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [],
      stopReason: "completed",
    });
  });

  it("lists the retries of a step's model call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let calls = 0;
      const { rows } = await traced({
        llm: scriptedLLM(() => {
          calls += 1;
          if (calls === 1) throw new Error("rate limited, try again");
          return prose("done");
        }),
        manifest: manifest({ maxRetries: 1 }),
      });
      const completed = stepRows(rows).find(
        (row) => row.type === "step.completed",
      );
      expect(completed?.payload.retries).toEqual([
        { attempt: 1, reason: "transient-error" },
      ]);
      expect(completed?.payload.stopReason).toBe("completed");
    } finally {
      warn.mockRestore();
    }
  });

  it("notes a correction, a rejected draft, a perturbation and an activated tool", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A requireToolUse runtime that first answers in prose gets corrected.
      const correction = await traced({
        llm: queuedLLM([
          prose("nothing to do"),
          toolCall("mark", { note: "a" }),
        ]),
        manifest: manifest({
          requireToolUse: true,
          completeAfterTools: ["mark"],
        }),
      });
      expect(stepRows(correction.rows)[1]?.payload.notes).toEqual([
        { kind: "no-tool-correction" },
      ]);

      // A rejected draft.
      const hookPipeline = createHookPipeline();
      let reviewed = 0;
      hookPipeline.register({
        id: "review",
        event: "PostLLMResponse",
        handler: async () =>
          ++reviewed === 1
            ? { action: "continue", replace: { correction: "Again." } }
            : { action: "continue" },
      });
      const rejected = await traced({
        llm: queuedLLM([prose("draft"), prose("final")]),
        hookPipeline,
      });
      expect(stepRows(rejected.rows)[1]?.payload.notes).toEqual([
        { kind: "review-rejected" },
      ]);

      // A perturbation after the same call three times in a row.
      let i = 0;
      const perturbed = await traced({
        llm: scriptedLLM((_params, call) =>
          call <= 3
            ? toolCall("mark", { note: "same" }, `tc-${i++}`)
            : prose("moved on"),
        ),
        maxSteps: 10,
      });
      expect(
        stepRows(perturbed.rows)
          .filter((row) => row.type === "step.completed")
          .flatMap((row) => row.payload.notes as unknown[]),
      ).toEqual([{ kind: "loop-perturbation" }]);

      // A deferred tool activated through search-tools.
      const rollDice = tool({
        name: "roll-dice",
        description: "Roll dice with an expression like 2d6+3.",
        parameters: z.object({ value: z.string() }),
        execute: async () => ({ rolled: 7 }),
      });
      const activated = await traced({
        llm: queuedLLM([
          toolCall(SEARCH_TOOLS_TOOL_NAME, { query: "roll dice" }),
          prose("rolled"),
        ]),
        manifest: manifest({
          tools: { builtin: ["roll-dice"], defer: true },
        } as never),
        deps: { toolExecutor: makeExecutor([rollDice]) },
      });
      expect(stepRows(activated.rows)[1]?.payload.notes).toEqual([
        { kind: "tool-activated", count: 1 },
      ]);
      for (const run of [correction, rejected, perturbed, activated])
        expectOneCompletedPerStarted(run.rows);
    } finally {
      warn.mockRestore();
    }
  });

  it("closes a thrown step once, with the tagged reason and no usage", async () => {
    let calls = 0;
    const { rows, error } = await traced({
      llm: scriptedLLM(() => {
        calls += 1;
        if (calls === 2) throw new Error("PROVIDER_ERROR: upstream exploded");
        return toolCall("mark", { note: "a" });
      }),
    });
    expect(error).toBeDefined();
    const completed = stepRows(rows).filter(
      (row) => row.type === "step.completed",
    );
    expect(completed.map((row) => row.payload.step)).toEqual([1, 2]);
    expect(completed[1]?.payload.stopReason).toBe("model-error");
    expect(completed[1]?.payload).not.toHaveProperty("usage");
    expectOneCompletedPerStarted(rows);
  });

  it("marks the finalizer step and puts the stop reason on it", async () => {
    let n = 0;
    const { rows } = await traced({
      llm: scriptedLLM((params) =>
        params.tools
          ? toolCall("mark", { note: `n${n}` }, `tc-${n++}`, "scratch")
          : prose("final"),
      ),
      maxSteps: 2,
    });
    const steps = stepRows(rows).map((row) => row.payload);
    expect(steps).toHaveLength(6);
    expect(steps[3]).not.toHaveProperty("stopReason");
    expect(steps[4]).toMatchObject({
      step: 3,
      finalizer: true,
      toolCount: 0,
      toolChoice: "auto",
    });
    expect(steps[5]).toMatchObject({
      step: 3,
      finalizer: true,
      stopReason: "max-steps",
    });
    expectOneCompletedPerStarted(rows);
  });

  it("keeps only content-free fields for a concealed runtime", async () => {
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "narrow",
      event: "PreStep",
      handler: async () => ({
        action: "continue",
        replace: { tools: ["mark", "secret-tool"] },
      }),
    });
    const { rows } = await traced({
      llm: queuedLLM([toolCall("mark", { note: "hidden" }), prose("done")]),
      hookPipeline,
      concealed: ["plug/loop"],
    });
    const allowed = new Set([
      "concealed",
      "flowId",
      "seq",
      "runtimeId",
      "pluginId",
      "turnId",
      "runId",
      "durationMs",
      "finishReason",
      "usage",
      "step",
      "stopReason",
      "finalizer",
      "retries",
      "notes",
    ]);
    const steps = stepRows(rows);
    expect(steps.length).toBeGreaterThan(0);
    for (const row of steps) {
      expect(row.payload.concealed).toBe(true);
      for (const key of Object.keys(row.payload))
        expect(allowed.has(key), key).toBe(true);
    }
    expect(steps[1]?.payload.notes).toEqual([
      { kind: "tool-narrowed", count: 1, ignored: 1 },
    ]);
    expect(steps[1]?.payload).not.toHaveProperty("toolCalls");
    expect(JSON.stringify(steps)).not.toContain("mark");
    expect(JSON.stringify(steps)).not.toContain("secret-tool");
  });

  it("does not fail the run when the emitter throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const emitter = {
        sessionId: "sess-loop",
        turnId: "turn-loop",
        emit: async (type: string) => {
          if (type.startsWith("step.")) throw new Error("trace store down");
        },
      } as unknown as TurnEmitter;
      const result = await runLoop({
        llm: queuedLLM([toolCall("mark", { note: "a" }), prose("done")]),
        deps: { emitter, toolExecutor: makeExecutor([markTool]) },
      });
      expect(result.stop).toEqual({ reason: "completed" });
      expect(result.finalContent).toBe("done");
    } finally {
      warn.mockRestore();
    }
  });
});
