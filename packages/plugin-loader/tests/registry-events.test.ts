/**
 * Tests for PluginRegistry EventBus bridge — verifies plugin lifecycle
 * events are emitted to the EventBus when one is provided.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { PluginType, SubscriptionEvent } from "@covel/shared";
import type { PluginRegistryEntry, PluginSummary } from "../src/types.js";
import { createPluginRegistry, type PluginRegistry } from "../src/registry.js";
import { createEventBus, type EventBus } from "@covel/events";

function makeSummary(id: string): PluginSummary {
  return {
    id,
    name: `Plugin ${id}`,
    description: `Description for ${id}`,
    pluginType: "plugin" as PluginType,
    runtimeCount: 1,
  };
}

function makeEntry(id: string): PluginRegistryEntry {
  return {
    id,
    summary: makeSummary(id),
    loadedRuntimes: new Map(),
    status: "registered",
  };
}

describe("PluginRegistry EventBus Bridge", () => {
  let registry: PluginRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = createEventBus();
    registry = createPluginRegistry({ eventBus });
  });

  it("retains the captured incarnation across asynchronous persistence", async () => {
    const strictBus = createEventBus(undefined, {
      requireSessionIncarnation: true,
      strictEmissions: true,
    });
    const scopedRegistry = createPluginRegistry({ eventBus: strictBus });
    scopedRegistry.register(makeEntry("alpha"));
    await scopedRegistry.applyPersistedActivations(
      "same-id",
      ["alpha"],
      async () => {
        await Promise.resolve();
      },
      "captured-incarnation",
    );
    expect(
      strictBus.getEventsAfter("same-id", 0).events[0]?.sessionIncarnation,
    ).toBe("captured-incarnation");
    await strictBus.close();
  });

  it("should emit plugin.activated event on applyPersistedActivations()", async () => {
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    registry.register(makeEntry("alpha"));
    await registry.applyPersistedActivations(
      "session-1",
      ["alpha"],
      async () => {},
      "test-incarnation",
    );

    const activated = events.find((e) => e.type === "plugin.activated");
    expect(activated).toBeDefined();
    expect(activated!.topic).toBe("plugin");
    expect(activated!.sessionId).toBe("session-1");
    expect((activated!.payload as Record<string, unknown>).pluginId).toBe(
      "alpha",
    );
  });

  it("should emit plugin.deactivated event when the persisted set drops a plugin", async () => {
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    registry.register(makeEntry("alpha"));
    await registry.applyPersistedActivations(
      "session-1",
      ["alpha"],
      async () => {},
      "test-incarnation",
    );
    await registry.applyPersistedActivations(
      "session-1",
      [],
      async () => {},
      "test-incarnation",
    );

    const deactivated = events.find((e) => e.type === "plugin.deactivated");
    expect(deactivated).toBeDefined();
    expect(deactivated!.topic).toBe("plugin");
    expect(deactivated!.sessionId).toBe("session-1");
    expect((deactivated!.payload as Record<string, unknown>).pluginId).toBe(
      "alpha",
    );
  });

  it("emits lifecycle events only for actual activation changes", async () => {
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((event) => events.push(event));
    registry.register(makeEntry("alpha"));

    await registry.applyPersistedActivations(
      "session-1",
      ["alpha"],
      async () => {},
      "test-incarnation",
    );
    await registry.applyPersistedActivations(
      "session-1",
      ["alpha"],
      async () => {},
      "test-incarnation",
    );
    await registry.applyPersistedActivations(
      "session-1",
      [],
      async () => {},
      "test-incarnation",
    );
    await registry.applyPersistedActivations(
      "session-1",
      [],
      async () => {},
      "test-incarnation",
    );

    expect(events.map((event) => event.type)).toEqual([
      "plugin.activated",
      "plugin.deactivated",
    ]);
  });

  it("should work without eventBus (backward compat)", async () => {
    const noEventBusRegistry = createPluginRegistry();
    noEventBusRegistry.register(makeEntry("beta"));
    await noEventBusRegistry.applyPersistedActivations(
      "session-1",
      ["beta"],
      async () => {},
      "test-incarnation",
    );
    await noEventBusRegistry.applyPersistedActivations(
      "session-1",
      [],
      async () => {},
      "test-incarnation",
    );
    // No errors thrown
    expect(noEventBusRegistry.get("beta")).toBeDefined();
  });
});
