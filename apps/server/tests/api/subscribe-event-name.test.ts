/**
 * `/api/events/stream` SSE event-name derivation — regression test for the
 * bug where `plugin-data.changed`, `world.dimensions.changed`, and other
 * dot-rich subTypes were collapsed to their topic + last segment because
 * `deriveSseEventName` read `payload._subType` *after* EventBus had already
 * stripped it onto `event.type`.
 *
 * Symptom observed in production: UI subscribes via the persistent
 * `/events/stream` channel and `switch (event.type)` on `plugin-data.changed`,
 * but the server emitted `event: plugin.changed` (topic + last dot segment),
 * so every right-panel / message-panel re-render was silently dropped.
 *
 * These tests drive the SSE envelope against what a real EventBus produces,
 * not against an arbitrary mock — so we catch any future drift between
 * EventBus payload conventions and the SSE formatter.
 */

import { describe, it, expect } from "vitest";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
import { deriveSseEventName } from "../../src/routes/api/subscribe.js";

describe("deriveSseEventName", () => {
  it("preserves full subType for plugin-data.changed emitted via EventBus", () => {
    const store = createMemoryStore();
    const eventBus = createEventBus(store);

    const received: Array<{
      topic: string;
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    eventBus.onEmit((ev) => {
      received.push({ topic: ev.topic, type: ev.type, payload: ev.payload });
    });

    // Shape matches emitPluginDataChangedEvent in bootstrap.ts exactly.
    eventBus.emit({
      id: "evt-1",
      type: "event",
      topic: "plugin",
      sessionId: "sess-1",
      timestamp: new Date().toISOString(),
      payload: {
        _subType: "plugin-data.changed",
        pluginId: "codex",
        changes: [
          {
            namespace: "entries",
            key: "codex-1",
            value: { title: "x" },
            operation: "set",
          },
        ],
      },
    });

    expect(received).toHaveLength(1);
    const ev = received[0];
    // EventBus moved _subType onto event.type and stripped it from payload.
    expect(ev.type).toBe("plugin-data.changed");
    expect(ev.payload._subType).toBeUndefined();

    // The SSE formatter must emit the full subType on the `event:` line,
    // not a topic-derived approximation. The frontend matches on the exact
    // string `plugin-data.changed` in its switch, so any loss here silently
    // drops every plugin panel refresh.
    expect(deriveSseEventName(ev)).toBe("plugin-data.changed");
  });

  it("preserves full subType for world.dimensions.changed", () => {
    const store = createMemoryStore();
    const eventBus = createEventBus(store);

    const received: Array<{
      topic: string;
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    eventBus.onEmit((ev) => {
      received.push({ topic: ev.topic, type: ev.type, payload: ev.payload });
    });

    eventBus.emit({
      id: "evt-2",
      type: "event",
      topic: "plugin",
      sessionId: "sess-1",
      timestamp: new Date().toISOString(),
      payload: {
        _subType: "world.dimensions.changed",
        worldId: "cloudmere",
      },
    });

    expect(received).toHaveLength(1);
    expect(deriveSseEventName(received[0])).toBe("world.dimensions.changed");
  });

  it("preserves simple runtime.started emitted via emitSubEvent", () => {
    const store = createMemoryStore();
    const eventBus = createEventBus(store);

    const received: Array<{
      topic: string;
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    eventBus.onEmit((ev) => {
      received.push({ topic: ev.topic, type: ev.type, payload: ev.payload });
    });

    // Shape matches emitSubEvent in packages/runtime/src/turn-executor.ts.
    eventBus.emit({
      id: "evt-3",
      type: "event",
      topic: "runtime",
      sessionId: "sess-1",
      timestamp: new Date().toISOString(),
      payload: {
        _subTopic: "runtime",
        _subType: "runtime.started",
        runtimeId: "narrator",
        pluginId: "narrator",
        stage: "narrative",
      },
    });

    expect(deriveSseEventName(received[0])).toBe("runtime.started");
  });

  it("falls back to topic when event has no _subType", () => {
    // A raw emit with no _subType should still produce a stable event name
    // (EventBus defaults event.type to the topic in that case).
    const store = createMemoryStore();
    const eventBus = createEventBus(store);

    const received: Array<{
      topic: string;
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    eventBus.onEmit((ev) => {
      received.push({ topic: ev.topic, type: ev.type, payload: ev.payload });
    });

    eventBus.emit({
      id: "evt-4",
      type: "event",
      topic: "state",
      sessionId: "sess-1",
      timestamp: new Date().toISOString(),
      payload: { value: 1 },
    });

    expect(deriveSseEventName(received[0])).toBe("state");
  });
});
