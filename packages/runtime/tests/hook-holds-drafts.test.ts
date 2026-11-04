import { describe, expect, it } from "vitest";
import { HookPipeline, runWithHookScope } from "../src/index.js";

const review = (pluginId: string, holdsDrafts: boolean) => ({
  id: `${pluginId}:ReviewAgentOutput:1`,
  event: "ReviewAgentOutput" as const,
  pluginId,
  ...(holdsDrafts ? { holdsDrafts: true } : {}),
  handler: async () => ({ action: "continue" as const }),
});

describe("holdsOutputDrafts", () => {
  it("is true only for a holding review that would run in the session", () => {
    const latched = new Set<string>();
    const pipeline = new HookPipeline({
      isPluginLatched: (_session, pluginId) => latched.has(pluginId),
    });
    pipeline.register(review("quality", false));
    expect(pipeline.holdsOutputDrafts("s")).toBe(false);

    pipeline.register(review("spoilers", true));
    const inSession = (ids: string[]) =>
      runWithHookScope({ activePluginIds: new Set(ids) }, () =>
        pipeline.holdsOutputDrafts("s"),
      );
    expect(inSession(["quality", "spoilers"])).toBe(true);
    // A plugin the session does not enable holds nothing.
    expect(inSession(["quality"])).toBe(false);
    // Neither does one whose hooks are switched off after failures.
    latched.add("spoilers");
    expect(inSession(["quality", "spoilers"])).toBe(false);
  });

  it("ignores the flag on other events", () => {
    const pipeline = new HookPipeline();
    pipeline.register({
      ...review("guard", true),
      id: "guard:PostRuntime:1",
      event: "PostRuntime",
    });
    expect(pipeline.holdsOutputDrafts("s")).toBe(false);
  });
});
