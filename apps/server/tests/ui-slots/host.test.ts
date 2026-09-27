import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
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
});
async function fixture() {
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
        pending: false,
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
    ).toEqual({ pending: false, name: "Gate lit" });
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
            pending: false,
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
      { handler: () => ({ pending: false, name: "Gate" }) },
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
      { handler: () => ({ pending: false, name }) },
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
      { handler: () => ({ pending: false, name: "Gate" }) },
    );
    f.extensionHost.register(
      "beta",
      { point: uiSlotV1.id, id: "bad", slot: "stage.backdrop@1" },
      { handler: () => ({ actors: [], retainWhenEmpty: false }) },
    );
    expect(
      (await f.host.get("session", { slot: "stage.backdrop@1" }))[0]?.value,
    ).toEqual({ pending: false, name: "Gate" });
  });
});
