import { describe, expect, it } from "vitest";
import {
  HookPipeline,
  runWithHookScope,
  type HookEvent,
} from "../src/index.js";

const hook = (
  pluginId: string,
  holdsDrafts: boolean,
  event: HookEvent = "ReviewAgentOutput",
  runsFor?: (sessionId: string) => boolean | Promise<boolean>,
) => ({
  id: `${pluginId}:${event}:1`,
  event,
  pluginId,
  ...(holdsDrafts ? { holdsDrafts: true } : {}),
  ...(runsFor ? { runsFor } : {}),
  handler: async () => ({ action: "continue" as const }),
});

const inSession = (pipeline: HookPipeline, ids: string[]) =>
  runWithHookScope({ activePluginIds: new Set(ids) }, () =>
    pipeline.outputDraftHold("s"),
  );

describe("outputDraftHold", () => {
  it("holds only for a holding hook that would run in the session", async () => {
    const latched = new Set<string>();
    const pipeline = new HookPipeline({
      isPluginLatched: (_session, pluginId) => latched.has(pluginId),
    });
    pipeline.register(hook("quality", false));
    await expect(pipeline.outputDraftHold("s")).resolves.toBeUndefined();

    pipeline.register(hook("spoilers", true));
    await expect(inSession(pipeline, ["quality", "spoilers"])).resolves.toBe(
      "review",
    );
    // A plugin the session does not enable holds nothing.
    await expect(inSession(pipeline, ["quality"])).resolves.toBeUndefined();
    // Neither does one whose hooks are switched off after failures.
    latched.add("spoilers");
    await expect(
      inSession(pipeline, ["quality", "spoilers"]),
    ).resolves.toBeUndefined();
  });

  it("waits for the commit when a PostRuntime hook may still replace the story", async () => {
    const pipeline = new HookPipeline();
    pipeline.register(hook("filter", true, "PostLLMResponse"));
    await expect(inSession(pipeline, ["filter"])).resolves.toBe("review");
    pipeline.register(hook("rewriter", true, "PreToolUse"));
    await expect(inSession(pipeline, ["rewriter"])).resolves.toBe("review");
    pipeline.register(hook("redactor", true, "PostRuntime"));
    await expect(inSession(pipeline, ["filter", "redactor"])).resolves.toBe(
      "commit",
    );
  });

  it("ignores the flag on events that cannot change the story", async () => {
    const pipeline = new HookPipeline();
    pipeline.register(hook("guard", true, "PostToolUse"));
    await expect(pipeline.outputDraftHold("s")).resolves.toBeUndefined();
  });

  it("ignores a hook that does not run for the session, such as an unapproved one", async () => {
    let approved = false;
    const pipeline = new HookPipeline();
    pipeline.register(
      hook("community-review", true, "ReviewAgentOutput", async () => approved),
    );
    await expect(
      inSession(pipeline, ["community-review"]),
    ).resolves.toBeUndefined();
    approved = true;
    await expect(inSession(pipeline, ["community-review"])).resolves.toBe(
      "review",
    );
  });
});
