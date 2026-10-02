import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import { PluginExtensionHost, PluginServiceRegistry } from "@covel/runtime";
import {
  uiSlotV1,
  type UiSlotProjectionInput,
  type PluginExtensionContext,
} from "@covel/shared";
import { createUiSlotHost, type UiSlotHost } from "../../src/ui-slots/host.js";
const disposables: UiSlotHost[] = [];
afterEach(async () => {
  await Promise.all(disposables.splice(0).map((host) => host.close()));
  vi.useRealTimers();
});
async function fixture(
  onProjection?: Parameters<typeof createUiSlotHost>[0]["onProjection"],
) {
  const store = createMemoryStore();
  await store.createSession({
    id: "session",
    worldId: "world",
    status: "active",
    locale: "en-US",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    activePlugins: ["alpha", "beta"],
    metadata: {},
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  });
  const active = new Set(["alpha", "beta"]);
  const services = new PluginServiceRegistry({
    list: async () => [...active],
    ensure: async () => {},
  });
  const extensionHost = new PluginExtensionHost(services, [uiSlotV1]);
  const eventBus = createEventBus();
  const changes: { type: string; payload: Record<string, unknown> }[] = [];
  eventBus.onEmit((event) => {
    if (event.type.startsWith("ui.slot.")) changes.push(event);
  });
  const host = createUiSlotHost({
    store,
    eventBus,
    services,
    extensionHost,
    debounceMs: 1,
    onProjection,
  });
  disposables.push(host);
  const emit = (type: string, payload: Record<string, unknown>) =>
    eventBus.emit({
      id: crypto.randomUUID(),
      type: "event",
      topic: "plugin",
      sessionId: "session",
      timestamp: new Date().toISOString(),
      payload: { ...payload, _subType: type },
    });
  return { store, active, services, extensionHost, host, changes, emit };
}
describe("UI slot projection host", () => {
  it("keeps an in-flight session and its queued reads alive across LRU eviction", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const base = (await f.store.getSession("session"))!;
    for (let index = 0; index < 256; index++)
      await f.store.createSession({ ...base, id: `other-${index}` });
    const started = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const handler = vi.fn(
      async (_input: UiSlotProjectionInput, ctx: PluginExtensionContext) => {
        if (ctx.sessionId === "session") {
          started.resolve();
          await blocked.promise;
        }
        return { name: ctx.sessionId };
      },
    );
    f.extensionHost.register(
      "alpha",
      {
        point: uiSlotV1.id,
        id: "backdrop",
        slot: "stage.backdrop@1",
      },
      { handler },
    );
    const query = { slot: "stage.backdrop@1" as const };
    const first = f.host.get("session", query);
    const queued = f.host.get("session", query);
    await started.promise;
    try {
      for (let index = 0; index < 256; index++)
        await f.host.get(`other-${index}`, query);
    } finally {
      blocked.resolve();
    }
    for (const result of await Promise.all([first, queued]))
      expect(result).toEqual([
        expect.objectContaining({ value: { name: "session" } }),
      ]);
    expect(
      handler.mock.calls.filter(([, ctx]) => ctx.sessionId === "session"),
    ).toHaveLength(1);
    // Idle entries still obey the cap, even while the oldest session is busy.
    const before = handler.mock.calls.length;
    await f.host.get("other-0", query);
    expect(handler).toHaveBeenCalledTimes(before + 1);
  });

  it("returns every concurrent projection when all sessions exceed the cache cap", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const base = (await f.store.getSession("session"))!;
    const ids = Array.from({ length: 257 }, (_, index) => `parallel-${index}`);
    for (const id of ids) await f.store.createSession({ ...base, id });
    const blocked = Promise.withResolvers<void>();
    const handler = vi.fn(
      async (_input: UiSlotProjectionInput, ctx: PluginExtensionContext) => {
        await blocked.promise;
        return { name: ctx.sessionId };
      },
    );
    f.extensionHost.register(
      "alpha",
      {
        point: uiSlotV1.id,
        id: "backdrop",
        slot: "stage.backdrop@1",
      },
      { handler },
    );
    const query = { slot: "stage.backdrop@1" as const };
    const requests = ids.map((id) => f.host.get(id, query));
    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(ids.length));
    } finally {
      blocked.resolve();
    }
    const results = await Promise.all(requests);
    for (const [index, result] of results.entries())
      expect(result).toEqual([
        expect.objectContaining({
          value: { name: ids[index] },
        }),
      ]);
    // Finishing work trims temporary overflow without dropping its response.
    await f.host.get(ids[0]!, query);
    expect(handler).toHaveBeenCalledTimes(ids.length + 1);
  });

  it("keeps a debounced update when every other cached session is busy", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const base = (await f.store.getSession("session"))!;
    const ids = Array.from({ length: 256 }, (_, index) => `busy-${index}`);
    for (const id of ids) await f.store.createSession({ ...base, id });
    const blocked = Promise.withResolvers<void>();
    const handler = vi.fn(
      async (_input: UiSlotProjectionInput, ctx: PluginExtensionContext) => {
        if (ctx.sessionId !== "session") await blocked.promise;
        return { name: ctx.sessionId };
      },
    );
    f.extensionHost.register(
      "alpha",
      {
        point: uiSlotV1.id,
        id: "backdrop",
        slot: "stage.backdrop@1",
        watch: ["stage"],
      },
      { handler },
    );
    const requests = ids.map((id) =>
      f.host.get(id, { slot: "stage.backdrop@1" }),
    );
    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(ids.length));
      f.emit("plugin-data.changed", {
        pluginId: "alpha",
        changes: [{ namespace: "stage" }],
      });
      await vi.waitFor(() =>
        expect(f.changes).toContainEqual(
          expect.objectContaining({
            type: "ui.slot.changed",
            payload: expect.objectContaining({
              value: { name: "session" },
            }),
          }),
        ),
      );
    } finally {
      blocked.resolve();
      await Promise.all(requests);
    }
  });

  it("composes ordered providers, isolates reads, caches unchanged values and watches only declared own namespaces", async () => {
    const f = await fixture();
    await f.store.setPluginData({
      sessionId: "session",
      pluginId: "alpha",
      namespace: "stage",
      key: "current",
      value: { name: "Gate" },
      updatedAt: "2026-01-01",
    });
    const first = vi.fn(
      async (_input: UiSlotProjectionInput, ctx: PluginExtensionContext) => ({
        name: (await ctx.pluginData.get("stage", "current"))?.value && "Gate",
      }),
    );
    const second = vi.fn((input: UiSlotProjectionInput) => ({
      ...(input.previous as object),
      name: "Gate lit",
    }));
    f.extensionHost.register(
      "beta",
      {
        point: uiSlotV1.id,
        id: "b",
        slot: "stage.backdrop@1",
        order: 1,
        watch: ["light"],
      },
      { handler: second },
    );
    f.extensionHost.register(
      "alpha",
      {
        point: uiSlotV1.id,
        id: "a",
        slot: "stage.backdrop@1",
        order: 0,
        watch: ["stage"],
      },
      { handler: first },
    );
    expect(
      (await f.host.get("session", { slot: "stage.backdrop@1" }))[0]?.value,
    ).toEqual({ name: "Gate lit" });
    await f.host.get("session", { slot: "stage.backdrop@1" });
    expect(first).toHaveBeenCalledOnce();
    f.emit("plugin-data.changed", {
      pluginId: "beta",
      changes: [{ namespace: "stage" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(first).toHaveBeenCalledOnce();
    f.emit("plugin-data.changed", {
      pluginId: "alpha",
      changes: [{ namespace: "stage" }],
    });
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(2));
    expect(
      f.changes.filter((event) => event.type === "ui.slot.changed"),
    ).toHaveLength(1);
  });
  it("splits visual inventories into keyed snapshots and clears removed keys", async () => {
    const f = await fixture();
    let values = [{ characterId: "hero" }, { characterId: "guest" }];
    f.extensionHost.register(
      "alpha",
      {
        point: uiSlotV1.id,
        id: "visual",
        slot: "character.visual@1",
        watch: ["art"],
      },
      { handler: () => ({ characters: values }) },
    );
    expect(
      (
        await f.host.get("session", { slot: "character.visual@1", key: "hero" })
      )[0]?.value,
    ).toEqual({ characterId: "hero" });
    values = [{ characterId: "hero" }];
    f.emit("plugin-data.changed", {
      pluginId: "alpha",
      changes: [{ namespace: "art" }],
    });
    await vi.waitFor(() =>
      expect(
        f.changes.some(
          (event) =>
            event.payload.key === "guest" && event.payload.value === null,
        ),
      ).toBe(true),
    );
  });
  it("drops a stale keyless placeholder once visual keys arrive", async () => {
    const f = await fixture();
    let values: { characterId: string }[] = [];
    f.extensionHost.register(
      "alpha",
      {
        point: uiSlotV1.id,
        id: "visual",
        slot: "character.visual@1",
        watch: ["art"],
      },
      { handler: () => ({ characters: values }) },
    );
    // Empty collection caches a keyless "cleared" snapshot for the slot.
    const cleared = await f.host.get("session", {
      slot: "character.visual@1",
    });
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ value: null });
    expect(cleared[0]).not.toHaveProperty("key");
    values = [{ characterId: "hero" }];
    f.emit("plugin-data.changed", {
      pluginId: "alpha",
      changes: [{ namespace: "art" }],
    });
    await vi.waitFor(async () => {
      const entries = await f.host.get("session", {
        slot: "character.visual@1",
      });
      expect(entries).toEqual([expect.objectContaining({ key: "hero" })]);
    });
  });
  it("discards an in-flight preview when its turn ends", async () => {
    const f = await fixture();
    let finish!: () => void;
    let started = false;
    f.extensionHost.register(
      "alpha",
      {
        point: uiSlotV1.id,
        id: "preview",
        slot: "stage.backdrop@1",
        preview: ["scene.set"],
      },
      {
        handler: async (input: UiSlotProjectionInput) => {
          if (input.events.length) {
            started = true;
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
          }
          return {
            name: input.events.length ? "Preview" : "Committed",
          };
        },
      },
    );
    f.emit("domain-event.previewed", {
      topic: "scene.set",
      data: { sceneId: "hall" },
      turnId: "turn",
    });
    await vi.waitFor(() => expect(started).toBe(true));
    f.emit("turn.completed", { turnId: "turn" });
    finish();
    await f.host.get("session", { slot: "stage.backdrop@1" });
    expect(f.changes.some((event) => event.type === "ui.slot.preview")).toBe(
      false,
    );
    expect(f.changes.some((event) => event.type === "ui.slot.cleared")).toBe(
      true,
    );
  });
  it("invalidates cached output when an admitted provider is disabled", async () => {
    const f = await fixture();
    f.extensionHost.register(
      "alpha",
      { point: uiSlotV1.id, id: "a", slot: "stage.backdrop@1" },
      { handler: () => ({ name: "Gate" }) },
    );
    await f.host.get("session", { slot: "stage.backdrop@1" });
    f.active.delete("alpha");
    f.host.invalidateSession("session");
    expect(
      (await f.host.get("session", { slot: "stage.backdrop@1" }))[0]?.value,
    ).toBeNull();
  });
  it("clears old previews and reprojects fresh data after checkpoint replacement", async () => {
    const f = await fixture();
    let name = "Before restore";
    f.extensionHost.register(
      "alpha",
      {
        point: uiSlotV1.id,
        id: "a",
        slot: "stage.backdrop@1",
        preview: ["scene.set"],
      },
      { handler: () => ({ name }) },
    );
    await f.host.get("session", { slot: "stage.backdrop@1" });
    f.emit("domain-event.previewed", {
      turnId: "old-turn",
      topic: "scene.set",
      data: { name },
    });
    await vi.waitFor(() =>
      expect(f.changes.some((event) => event.type === "ui.slot.preview")).toBe(
        true,
      ),
    );
    f.host.clearSession("session");
    name = "After restore";
    f.host.invalidateSession("session");
    expect(
      (await f.host.get("session", { slot: "stage.backdrop@1" }))[0]?.value,
    ).toMatchObject({ name });
    expect(f.changes).toContainEqual(
      expect.objectContaining({
        type: "ui.slot.cleared",
        payload: expect.objectContaining({ turnId: "old-turn" }),
      }),
    );
  });
  it("skips a provider returning another slot's valid shape", async () => {
    const f = await fixture();
    f.extensionHost.register(
      "alpha",
      { point: uiSlotV1.id, id: "good", slot: "stage.backdrop@1" },
      { handler: () => ({ name: "Gate" }) },
    );
    f.extensionHost.register(
      "beta",
      { point: uiSlotV1.id, id: "bad", slot: "stage.backdrop@1" },
      { handler: () => ({ actors: [], retainWhenEmpty: false }) },
    );
    expect(
      (await f.host.get("session", { slot: "stage.backdrop@1" }))[0]?.value,
    ).toEqual({ name: "Gate" });
  });
});

it("coalesces repeated multi-provider bursts and reports each real projection once", async () => {
  const samples: number[] = [];
  const f = await fixture((metric) => samples.push(metric.durationMs));
  const first = vi.fn(async (_input, ctx) => ({
    name:
      (await ctx.pluginData.get("places", "current"))?.value?.name ?? "Cold",
  }));
  const second = vi.fn((input) => ({
    ...input.previous,
    name: `${input.previous.name} lit`,
  }));
  f.extensionHost.register(
    "alpha",
    {
      point: uiSlotV1.id,
      id: "location",
      slot: "stage.backdrop@1",
      watch: ["places"],
    },
    { handler: first },
  );
  f.extensionHost.register(
    "beta",
    {
      point: uiSlotV1.id,
      id: "lighting",
      slot: "stage.backdrop@1",
      order: 1,
      watch: ["lighting"],
    },
    { handler: second },
  );
  await f.host.get("session", { slot: "stage.backdrop@1" });
  for (let batch = 1; batch <= 10; batch++) {
    await f.store.setPluginData({
      sessionId: "session",
      pluginId: "alpha",
      namespace: "places",
      key: "current",
      value: { name: `Place ${batch}` },
      updatedAt: new Date().toISOString(),
    });
    for (let update = 0; update < 20; update++)
      f.emit("plugin-data.changed", {
        pluginId: update % 2 ? "alpha" : "beta",
        changes: [{ namespace: update % 2 ? "places" : "lighting" }],
      });
    await vi.waitFor(() => expect(samples).toHaveLength(batch + 1));
    expect(first).toHaveBeenCalledTimes(batch + 1);
    expect(second).toHaveBeenCalledTimes(batch + 1);
    expect(
      (await f.host.get("session", { slot: "stage.backdrop@1" }))[0]?.value,
    ).toEqual({ name: `Place ${batch} lit` });
  }
  const count = f.changes.filter(
    (event) => event.type === "ui.slot.changed",
  ).length;
  f.emit("plugin-data.changed", {
    pluginId: "alpha",
    changes: [{ namespace: "places" }],
  });
  await vi.waitFor(() => expect(samples).toHaveLength(12));
  expect(
    f.changes.filter((event) => event.type === "ui.slot.changed"),
  ).toHaveLength(count);
  const warm = samples.slice(1).sort((a, b) => a - b);
  process.stdout.write(
    JSON.stringify({
      kind: "synthetic-projection",
      providers: 2,
      coldMs: samples[0],
      warmSamples: warm.length,
      medianMs: warm[Math.floor(warm.length / 2)],
      p95Ms: warm[Math.ceil(warm.length * 0.95) - 1],
      maxMs: warm.at(-1),
    }) + "\n",
  );
});
