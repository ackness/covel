import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeDoneTool } from "@covel/tools";
import { createCorrectionPolicy } from "../src/agent-loop/correction-policy.js";
import {
  LOOP_PRESETS,
  resolveLoopProfile,
} from "../src/agent-loop/loop-profile.js";
import { stopOf } from "../src/agent-loop/stop-reason.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";
import {
  makeExecutor,
  manifest,
  markTool,
  prose,
  queuedLLM,
  runLoop,
  scriptedLLM,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

async function thrownBy(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

afterEach(() => vi.restoreAllMocks());

describe("correction policy", () => {
  it("bounds each kind independently and returns frozen snapshot copies", () => {
    const policy = createCorrectionPolicy({
      toolUse: 1,
      review: 2,
      loopPerturbation: 0,
      outputRepair: 3,
    });
    const before = policy.snapshot();
    expect(policy.take("loopPerturbation")).toBe(false);
    for (const [kind, budget] of [
      ["toolUse", 1],
      ["review", 2],
      ["outputRepair", 3],
    ] as const) {
      for (let i = 0; i < budget; i++) expect(policy.take(kind)).toBe(true);
      expect(policy.take(kind)).toBe(false);
      expect(policy.take(kind)).toBe(false);
      expect(policy.used(kind)).toBe(budget);
    }
    expect(before).toEqual({
      toolUse: 0,
      review: 0,
      loopPerturbation: 0,
      outputRepair: 0,
    });
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(policy.snapshot())).toBe(true);
    expect(policy.snapshot()).not.toBe(before);
  });

  it("preserves every preset's budgets and merges only authored keys", () => {
    for (const preset of ["story", "actor", "system"] as const) {
      expect(LOOP_PRESETS[preset].corrections).toEqual({
        toolUse: 1,
        review: 2,
        loopPerturbation: 1,
        outputRepair: 1,
      });
      expect(Object.isFrozen(LOOP_PRESETS[preset].corrections)).toBe(true);
      expect(
        resolveLoopProfile(
          manifest({ loopProfile: { preset, corrections: { review: 0 } } }),
        ).corrections,
      ).toEqual({
        toolUse: 1,
        review: 0,
        loopPerturbation: 1,
        outputRepair: 1,
      });
    }
  });
});

describe("corrections in the loop", () => {
  it.each([false, true])(
    "shares the default tool-use budget (runtime-done first: %s)",
    async (doneFirst) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const emitter = makeEmitterSpy();
      const llm = queuedLLM([
        doneFirst ? toolCall("runtime-done", {}) : prose("done"),
        prose("still done"),
      ]);
      const result = await runLoop({
        llm,
        manifest: manifest({ requireToolUse: true }),
        deps: {
          toolExecutor: makeExecutor([markTool, runtimeDoneTool]),
          emitter,
        },
      });
      expect(llm.requests).toHaveLength(2);
      expect(result.requiredToolUseUnmet).toBe(true);
      const notes = emitter.events
        .filter((e) => e.type === "step.completed")
        .flatMap((e) => e.payload.notes);
      expect(notes).toEqual([
        { kind: doneFirst ? "runtime-done-correction" : "no-tool-correction" },
      ]);
    },
  );

  it.each([0, 3])("uses a tool-use budget of %s", async (toolUse) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = queuedLLM([prose("done")]);
    const result = await runLoop({
      llm,
      manifest: manifest({
        requireToolUse: true,
        loopProfile: { corrections: { toolUse } },
      }),
    });
    expect(llm.requests).toHaveLength(toolUse + 1);
    expect(result.requiredToolUseUnmet).toBe(true);
  });

  it.each([0, 2])(
    "rejects after consuming a review budget of %s",
    async (review) => {
      const hookPipeline = createHookPipeline();
      hookPipeline.register({
        id: "reject",
        event: "PostLLMResponse",
        handler: async () => ({
          action: "continue",
          replace: { correction: "Use the selected perspective." },
        }),
      });
      const llm = queuedLLM([prose("rejected")]);
      const error = await thrownBy(
        runLoop({
          llm,
          hookPipeline,
          manifest: manifest({ loopProfile: { corrections: { review } } }),
        }),
      );
      expect(String(error)).toContain(
        "Response validation failed: Use the selected perspective.",
      );
      expect(stopOf(error)).toEqual({ reason: "invalid-output" });
      expect(llm.requests).toHaveLength(review + 1);
    },
  );

  it.each(["fail", "answer-without-tools"] as const)(
    "uses %s at the first detection with perturbation budget zero",
    async (fallback) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const emitter = makeEmitterSpy();
      const llm = scriptedLLM((params, call) =>
        params.tools
          ? toolCall("mark", { note: "same" }, `tc-${call}`)
          : prose("answer"),
      );
      const promise = runLoop({
        llm,
        maxSteps: 10,
        deps: { emitter },
        manifest: manifest({
          loopProfile: { fallback, corrections: { loopPerturbation: 0 } },
        }),
      });
      if (fallback === "fail")
        expect(stopOf(await thrownBy(promise))).toEqual({
          reason: "loop-detected",
        });
      else {
        expect((await promise).finalContent).toBe("answer");
        expect(llm.requests.at(-1)?.tools).toBeUndefined();
      }
      expect(llm.requests).toHaveLength(fallback === "fail" ? 3 : 4);
      expect(
        emitter.events
          .filter((e) => e.type === "step.completed")
          .flatMap((e) => e.payload.notes),
      ).not.toContainEqual({ kind: "loop-perturbation" });
    },
  );
});
