/**
 * Tests for PluginRegistry EventBus bridge — verifies plugin lifecycle
 * events are emitted to the EventBus when one is provided.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
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

  it("should emit plugin.activated event on applyPersistedActivations()", async () => {
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    registry.register(makeEntry("alpha"));
    await registry.applyPersistedActivations(
      "session-1",
      ["alpha"],
      async () => {},
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
    );
    await registry.applyPersistedActivations("session-1", [], async () => {});

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
    );
    await registry.applyPersistedActivations(
      "session-1",
      ["alpha"],
      async () => {},
    );
    await registry.applyPersistedActivations("session-1", [], async () => {});
    await registry.applyPersistedActivations("session-1", [], async () => {});

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
    );
    await noEventBusRegistry.applyPersistedActivations(
      "session-1",
      [],
      async () => {},
    );
    // No errors thrown
    expect(noEventBusRegistry.get("beta")).toBeDefined();
  });
});
