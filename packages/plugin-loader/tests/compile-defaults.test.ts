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
      type: "function",
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
      type: "agent",
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
      type: "agent",
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
      type: "agent",
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
        type: "function",
        function: { handler: "./handler.js" },
        schedule: { stage: "post-turn" },
      }).trigger,
    ).toBeUndefined();
  });

  it("moves the cadence into an `auto` trigger", () => {
    expect(
      compile({
        type: "function",
        function: { handler: "./handler.js" },
        schedule: { stage: "post-turn", every: 3, trigger: { startTurn: 2 } },
      }).trigger,
    ).toEqual({ type: "auto", every: 3, startTurn: 2 });
  });
});
