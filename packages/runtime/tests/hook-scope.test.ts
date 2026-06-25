/**
 * Session-scope hook filtering (audit fix A).
 *
 * A plugin's hooks must only fire for sessions where the plugin is active;
 * framework hooks (no pluginId) always fire; with no scope set, all run.
 */

import { describe, it, expect, vi } from "vitest";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { runWithHookScope } from "../src/hooks/hook-scope.js";
import type { HookContext } from "../src/hooks/types.js";

const ctx: HookContext = {
  event: "PreRuntime",
  sessionId: "s1",
  turnId: "t1",
};

function pipelineWith(
  handlers: { id: string; pluginId?: string; fn: ReturnType<typeof vi.fn> }[],
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

  it("runs all hooks when no scope is set (e.g. unit tests / non-turn callers)", async () => {
    const a = vi.fn().mockResolvedValue({ action: "continue" });
    const b = vi.fn().mockResolvedValue({ action: "continue" });
    const p = pipelineWith([
      { id: "a", pluginId: "plugin-a", fn: a },
      { id: "b", pluginId: "plugin-b", fn: b },
    ]);

    await p.run("PreRuntime", ctx, {});

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
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
