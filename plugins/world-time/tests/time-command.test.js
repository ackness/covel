import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoverPlugins, loadPluginManifest } from "@covel/plugin-loader";
import { worldTimeSchema } from "@covel/shared";
import time from "../rpc/time.js";
import register from "../server/index.js";
import { DEFAULT_TIME, initialTick } from "../clock.js";

function context(value, locale = "en") {
  return {
    sessionId: "session",
    pluginId: "world-time",
    locale,
    store: {
      getPluginData: vi.fn(async () => (value ? { value } : null)),
      setPluginData: vi.fn(),
      getWorld: vi.fn(),
    },
  };
}

describe("world-time command", () => {
  it("discovers /time and registers its action on the owning plugin", async () => {
    const entry = (
      await discoverPlugins(path.resolve(import.meta.dirname, "../.."))
    ).find((plugin) => plugin.id === "world-time");
    const manifests = await loadPluginManifest(entry);
    expect(
      manifests.flatMap(({ manifest }) => manifest.commands ?? []),
    ).toEqual([expect.objectContaining({ name: "time", action: "time" })]);
    const registerRpc = vi.fn();
    register({
      registerRpc,
      registerTool: vi.fn(),
      toolkit: { tool: (definition) => definition, store: {} },
    });
    expect(registerRpc).toHaveBeenCalledWith("time", time, expect.any(Object));
  });

  it("reports an unrecorded clock without synthesizing or writing an initial time", async () => {
    const ctx = context(null, "zh-CN");
    const result = await time({}, ctx);
    expect(result).toMatchObject({
      ok: true,
      data: { initialized: false },
    });
    expect(result.message).toContain("尚未记录");
    expect(ctx.store.setPluginData).not.toHaveBeenCalled();
    expect(ctx.store.getWorld).not.toHaveBeenCalled();
  });

  it("formats the committed calendar in the session locale and leaves its tick and turn unchanged", async () => {
    const value = {
      schemaVersion: 1,
      definition: DEFAULT_TIME,
      tick: initialTick(DEFAULT_TIME) + 60,
      display: "Stale cached display",
      lastTurnId: "turn-1",
      lastDelta: 60,
      reason: "An hour passed.",
    };
    const before = structuredClone(value);
    const ctx = context(value, "zh-CN");
    const result = await time({}, ctx);
    expect(result.message).toContain("世界历 1 · 1月 1 · 09:00 · 早晨");
    expect(result.data).toMatchObject({
      initialized: true,
      tick: value.tick,
      lastTurnId: "turn-1",
      lastDelta: 60,
    });
    expect(value).toEqual(before);
    expect(ctx.store.getPluginData).toHaveBeenCalledWith(
      "session",
      "world-time",
      "clock",
      "current",
    );
    expect(ctx.store.setPluginData).not.toHaveBeenCalled();
    expect(ctx.store.getWorld).not.toHaveBeenCalled();
  });

  it.each(["backward", "random"])(
    "reads negative %s phases repeatedly without another evolution",
    async (mode) => {
      const definition = worldTimeSchema.parse({
        kind: "phases",
        name: "Dream clock",
        cycleLabel: { zh: "梦回", en: "Dream" },
        phases: ["Dawn", "Day", "Dusk", "Night"],
        initial: { cycle: 0, phase: 0 },
        evolution: {
          mode,
          defaultStep: 1,
          maxStep: 3,
          ...(mode === "random" ? { randomRange: { min: -3, max: 3 } } : {}),
        },
      });
      const ctx = context({
        schemaVersion: 1,
        definition,
        tick: -1,
        lastTurnId: "turn-2",
        lastDelta: -1,
      });
      const first = await time({}, ctx);
      const second = await time({}, ctx);
      expect(first.message).toBe("World time: Dream -1 · Night");
      expect(first.data).toMatchObject({ tick: -1, cycle: -1, phase: 3 });
      expect(second).toEqual(first);
      expect(ctx.store.setPluginData).not.toHaveBeenCalled();
    },
  );

  it("rejects corrupt recorded state instead of presenting an invented time", async () => {
    await expect(time({}, context({ schemaVersion: 2 }))).rejects.toThrow(
      "Invalid stored world time",
    );
    await expect(
      time(
        {},
        context({
          schemaVersion: 1,
          definition: DEFAULT_TIME,
          tick: 1.5,
        }),
      ),
    ).rejects.toThrow("safe integer");
  });
});
