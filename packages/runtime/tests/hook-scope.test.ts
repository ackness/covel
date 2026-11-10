/**
 * Session-scope hook filtering (audit fix A).
 *
 * A plugin's hooks must only fire for sessions where the plugin is active;
 * framework hooks (no pluginId) always fire; with no scope set, nothing runs
 * and the pipeline throws `MissingHookScopeError`.
 */

import { describe, it, expect, vi, type Mock } from "vitest";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  MissingHookScopeError,
  runWithHookScope,
} from "../src/hooks/hook-scope.js";
import type { HookContext, HookHandler } from "../src/hooks/types.js";

const ctx: HookContext = {
  event: "PreRuntime",
  sessionId: "s1",
  turnId: "t1",
};

function pipelineWith(
  handlers: { id: string; pluginId?: string; fn: Mock<HookHandler> }[],
) {
  const p = createHookPipeline();
  for (const h of handlers) {
    p.register({
      id: h.id,
      event: "PreRuntime",
      ...(h.pluginId ? { pluginId: h.pluginId } : {}),
      handler: h.fn,
    });
  }
  return p;
}

describe("hook session scope", () => {
  it("skips a plugin's hook when the plugin is not active in the session", async () => {
    const active = vi.fn().mockResolvedValue({ action: "continue" });
    const inactive = vi.fn().mockResolvedValue({ action: "continue" });
    const framework = vi.fn().mockResolvedValue({ action: "continue" });
    const p = pipelineWith([
      { id: "a", pluginId: "plugin-a", fn: active },
      { id: "b", pluginId: "plugin-b", fn: inactive },
      { id: "f", fn: framework }, // no pluginId → framework
    ]);

    await runWithHookScope({ activePluginIds: new Set(["plugin-a"]) }, () =>
      p.run("PreRuntime", ctx, {}),
    );

    expect(active).toHaveBeenCalledOnce();
    expect(framework).toHaveBeenCalledOnce();
    expect(inactive).not.toHaveBeenCalled(); // plugin-b not active → filtered
  });

  it("runs no hook and names the missing scope when no scope is set", async () => {
    const a = vi.fn().mockResolvedValue({ action: "continue" });
    const framework = vi.fn().mockResolvedValue({ action: "continue" });
    const p = pipelineWith([
      { id: "a", pluginId: "plugin-a", fn: a },
      { id: "f", fn: framework },
    ]);

    const run = p.run("PreRuntime", ctx, {});
    await expect(run).rejects.toThrow(MissingHookScopeError);
    await expect(run).rejects.toMatchObject({
      name: "MissingHookScopeError",
      operation: 'HookPipeline.run("PreRuntime")',
      message: expect.stringContaining("runWithHookScope"),
    });
    expect(a).not.toHaveBeenCalled();
    expect(framework).not.toHaveBeenCalled();
  });

  it("refuses an unscoped run even when no handler is registered", async () => {
    // A forgotten scope fails on the first hook site, not only once a plugin
    // happens to register a handler for that event.
    await expect(
      createHookPipeline().run("TurnStop", { ...ctx, event: "TurnStop" }, {}),
    ).rejects.toThrow(MissingHookScopeError);
  });

  it("refuses to compute the story draft hold outside a scope", async () => {
    await expect(createHookPipeline().outputDraftHold("s1")).rejects.toThrow(
      /HookPipeline\.outputDraftHold\(\) ran outside a session hook scope/,
    );
  });

  it("keeps the scope across awaits and gives concurrent sessions their own", async () => {
    const seen: Array<readonly string[]> = [];
    const fn = vi.fn().mockImplementation(async (c: HookContext) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push([...(c.activePluginIds ?? [])]);
      return { action: "continue" };
    });
    const p = pipelineWith([
      { id: "a", pluginId: "plugin-a", fn },
      { id: "b", pluginId: "plugin-b", fn },
    ]);

    await Promise.all([
      runWithHookScope({ activePluginIds: new Set(["plugin-a"]) }, async () => {
        await Promise.resolve();
        await p.run("PreRuntime", ctx, {});
      }),
      runWithHookScope({ activePluginIds: new Set(["plugin-b"]) }, () =>
        p.run("PreRuntime", { ...ctx, sessionId: "s2" }, {}),
      ),
    ]);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(seen.sort()).toEqual([["plugin-a"], ["plugin-b"]]);
  });

  it("exposes activePluginIds to the handler via ctx", async () => {
    let seen: ReadonlySet<string> | undefined;
    const fn = vi.fn().mockImplementation(async (c: HookContext) => {
      seen = c.activePluginIds;
      return { action: "continue" };
    });
    const p = pipelineWith([{ id: "a", pluginId: "plugin-a", fn }]);

    await runWithHookScope({ activePluginIds: new Set(["plugin-a"]) }, () =>
      p.run("PreRuntime", ctx, {}),
    );

    expect(seen).toBeDefined();
    expect(seen!.has("plugin-a")).toBe(true);
  });
});
