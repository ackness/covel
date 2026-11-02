import { afterEach, describe, expect, it, vi } from "vitest";

import { createCorrectionPolicy } from "../src/agent-loop/correction-policy.js";
import {
  LOOP_PRESETS,
  resolveLoopProfile,
} from "../src/agent-loop/loop-profile.js";
import { stopOf } from "../src/agent-loop/stop-reason.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";
import {
  manifest,
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

  it("counts a seed from before a suspension against the budget", () => {
    const policy = createCorrectionPolicy(
      { toolUse: 2, review: 2, loopPerturbation: 1, outputRepair: 1 },
      { toolUse: 1, loopPerturbation: 1 },
    );
    expect(policy.snapshot()).toEqual({
      toolUse: 1,
      review: 0,
      loopPerturbation: 1,
      outputRepair: 0,
    });
    expect(policy.take("loopPerturbation")).toBe(false);
    expect(policy.take("toolUse")).toBe(true);
    expect(policy.take("toolUse")).toBe(false);
    expect(policy.used("toolUse")).toBe(2);
    expect(policy.snapshot()).toMatchObject({ toolUse: 2 });
  });

  it("preserves every preset's budgets and merges only authored keys", () => {
    for (const preset of ["story", "actor", "system"] as const) {
      // Player-visible profiles get a second output repair: one missed
      // submission plus one cut-off JSON must not lose the turn.
      const outputRepair = preset === "system" ? 1 : 2;
      expect(LOOP_PRESETS[preset].corrections).toEqual({
        toolUse: 1,
        review: 2,
        loopPerturbation: 1,
        outputRepair,
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
        outputRepair,
      });
    }
  });
});

describe("corrections in the loop", () => {
  it.each([0, 3])("uses a tool-use budget of %s", async (toolUse) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = queuedLLM([toolCall("submit-output", {})]);
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
      const result = await runLoop({
        llm,
        hookPipeline,
        manifest: manifest({ loopProfile: { corrections: { review } } }),
      });
      expect(result.stop).toEqual({ reason: "invalid-output" });
      expect(llm.requests).toHaveLength(review + 1);
    },
  );

  it.each(["fail", "submit-output"] as const)(
    "uses %s at the first detection with perturbation budget zero",
    async (fallback) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const emitter = makeEmitterSpy();
      const llm = scriptedLLM((params, call) =>
        params.tools?.some((tool) => tool.name === "mark")
          ? toolCall("mark", { note: "same" }, `tc-${call}`)
          : toolCall("submit-output", { narrativeOutput: "answer" }),
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
        expect(stopOf(await thrownBy(promise), "run-loop")).toEqual({
          reason: "loop-detected",
        });
      else {
        expect((await promise).acceptedOutput?.narrativeOutput).toBe("answer");
        expect(llm.requests.at(-1)?.tools?.map((tool) => tool.name)).toEqual([
          "submit-output",
        ]);
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
