import { AGENT_LOOP_DEFAULTS } from "@covel/shared";
import type { PluginManifest, RuntimeAuthoringManifest } from "@covel/shared";
import { describe, expect, it } from "vitest";
import { compileRuntimeManifest } from "../src/compile-manifest.js";

const plugin: PluginManifest = {
  id: "probe",
  kind: "plugin",
  description: "Probe",
};

function compile(runtime: RuntimeAuthoringManifest) {
  return compileRuntimeManifest(plugin, runtime, "probe/notes");
}

describe("defaults the compiler fills in", () => {
  it("makes a runtime without a visibility a system runtime", () => {
    const manifest = compile({
      function: { handler: "./handler.js" },
      schedule: { stage: "post-turn" },
    });
    expect(manifest.outputKind).toBe("system");
    // A function runtime names a slot only when its handler calls a model,
    // and has no agent loop.
    expect(manifest.model).toBeUndefined();
    expect(manifest.timeoutMs).toBeUndefined();
    expect(manifest.maxRetries).toBeUndefined();
  });

  it("gives a system agent the plugin slot and the system loop limits", () => {
    const manifest = compile({
      schedule: { stage: "post-turn" },
    });
    expect(manifest).toMatchObject({
      outputKind: "system",
      model: "plugin",
      timeoutMs: 120000,
      callTimeoutMs: 60000,
      maxRetries: 3,
    });
    expect(AGENT_LOOP_DEFAULTS.system).toEqual({
      timeoutMs: 120000,
      callTimeoutMs: 60000,
      maxRetries: 3,
    });
  });

  it("gives a story agent the story slot and the story loop limits", () => {
    const manifest = compile({
      schedule: { stage: "narrative" },
      io: { visibility: "story" },
    });
    expect(manifest).toMatchObject({
      outputKind: "story",
      model: "story",
      timeoutMs: 240000,
      callTimeoutMs: 120000,
      maxRetries: 1,
    });
  });

  it("keeps every limit and slot the agent writes", () => {
    const manifest = compile({
      schedule: { stage: "post-turn" },
      agent: {
        model: "utility",
        loop: { timeoutMs: 180000, callTimeoutMs: 30000, maxRetries: 0 },
      },
    });
    expect(manifest).toMatchObject({
      model: "utility",
      timeoutMs: 180000,
      callTimeoutMs: 30000,
      maxRetries: 0,
    });
  });

  it("leaves the trigger out of a runtime that declares none: `auto`", () => {
    expect(
      compile({
        function: { handler: "./handler.js" },
        schedule: { stage: "post-turn" },
      }).trigger,
    ).toBeUndefined();
  });

  it("moves the cadence into an `auto` trigger", () => {
    expect(
      compile({
        function: { handler: "./handler.js" },
        schedule: { stage: "post-turn", every: 3, trigger: { startTurn: 2 } },
      }).trigger,
    ).toEqual({ type: "auto", every: 3, startTurn: 2 });
  });
});

describe("the agent loop profile", () => {
  it("carries no loopProfile when the author wrote no profile key", () => {
    for (const runtime of [
      { schedule: { stage: "narrative" }, io: { visibility: "story" } },
      { schedule: { stage: "post-turn" }, agent: { loop: { maxSteps: 3 } } },
    ] satisfies RuntimeAuthoringManifest[])
      expect(compile(runtime)).not.toHaveProperty("loopProfile");
  });

  it("maps agent.loop.profile and the overrides it names to loopProfile", () => {
    const manifest = compile({
      schedule: { stage: "post-turn" },
      agent: {
        loop: {
          maxSteps: 4,
          profile: "actor",
          fallback: "fail",
          finalizer: { deadlineReserveMs: 5000 },
        },
      },
    });
    expect(manifest.loopProfile).toEqual({
      preset: "actor",
      fallback: "fail",
      finalizer: { deadlineReserveMs: 5000 },
    });
    expect(manifest.maxSteps).toBe(4);
  });

  it("keeps every written key, defaults included, and nothing else", () => {
    const manifest = compile({
      schedule: { stage: "narrative" },
      io: { visibility: "story" },
      agent: {
        loop: {
          stream: true,
          steering: false,
          truncation: "reject",
          finalizer: { maxSteps: false },
        },
      },
    });
    expect(manifest.loopProfile).toEqual({
      stream: true,
      steering: false,
      truncation: "reject",
      finalizer: { maxSteps: false },
    });
  });
});
