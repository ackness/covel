/**
 * plugin-data DELETE — asserts the store wrapper emits plugin-data.changed
 * with operation: 'delete'. Fix for 2026-04-12 audit Finding w4.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createEventBus, type EventBus } from "@covel/events";
import { createMemoryStore, type DataStore } from "@covel/store";
import { wrapStoreWithPluginDataEvents } from "../../src/routes/api/bootstrap.js";

interface SubEvent {
  type: string;
  payload: Record<string, unknown>;
  sessionId: string;
}

describe("deletePluginData emits plugin-data.changed", () => {
  let eventBus: EventBus;
  let wrappedStore: DataStore;
  const sessionId = "sess-1";
  const pluginId = "codex";

  beforeEach(async () => {
    const baseStore: DataStore = createMemoryStore();
    eventBus = createEventBus(baseStore);
    wrappedStore = wrapStoreWithPluginDataEvents(baseStore, eventBus);

    await wrappedStore.setPluginData({
      id: "pd-1",
      sessionId,
      pluginId,
      namespace: "entries",
      key: "k1",
      value: { hello: "world" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  it("emits plugin-data.changed with operation=delete when deletePluginData is called", async () => {
    // actions.ts subscribes via onEmit() and filters by SubscriptionEvent.type,
    // which is derived from payload._subType. Mirror that here.
    const received: SubEvent[] = [];
    eventBus.onEmit((ev) => {
      if (ev.type === "plugin-data.changed") received.push(ev as SubEvent);
    });

    await wrappedStore.deletePluginData(sessionId, pluginId, "entries", "k1");

    // setPluginData in beforeEach also fires one event, so we filter for the
    // delete one specifically (it's the one fired by this test's call).
    const deleteEvents = received.filter((ev) => {
      const changes = ev.payload.changes as Array<{ operation: string }>;
      return changes?.[0]?.operation === "delete";
    });
    expect(deleteEvents).toHaveLength(1);
    const payload = deleteEvents[0].payload;
    expect(payload.pluginId).toBe(pluginId);
    const changes = payload.changes as Array<{
      key: string;
      namespace: string;
      operation: string;
    }>;
    expect(changes).toHaveLength(1);
    expect(changes[0].key).toBe("k1");
    expect(changes[0].namespace).toBe("entries");
    expect(changes[0].operation).toBe("delete");
  });

  it("actually deletes the row from the underlying store", async () => {
    await wrappedStore.deletePluginData(sessionId, pluginId, "entries", "k1");
    const result = await wrappedStore.getPluginData(
      sessionId,
      pluginId,
      "entries",
      "k1",
    );
    expect(result).toBeNull();
  });
});
