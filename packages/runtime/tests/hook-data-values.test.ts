import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import {
  getPendingProposals,
  getToolContent,
  withPendingProposals,
} from "@covel/tools";
import { cloneHookData } from "../src/hooks/hook-data.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";

describe("Hook snapshot data", () => {
  it("inspects the actual backing buffer when a view subclasses a native type", () => {
    class View extends Uint8Array {
      override get buffer(): ArrayBuffer {
        return new ArrayBuffer(1);
      }
    }
    expect(() => cloneHookData(new View(new SharedArrayBuffer(1)))).toThrow(
      "Hook data cannot contain shared memory",
    );
  });

  it("rejects a view's own accessor before inspecting its backing buffer", () => {
    const view = new Uint8Array(1);
    const getter = vi.fn(() => new ArrayBuffer(1));
    Object.defineProperty(view, "buffer", { get: getter });
    expect(() => cloneHookData(view)).toThrow(
      "Hook data cannot contain accessors",
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("retains numeric custom properties on DataView as owned data", () => {
    const view = new DataView(new ArrayBuffer(1));
    Object.defineProperty(view, "0", { value: { content: "original" } });
    const copied = cloneHookData(view);
    const property = Object.getOwnPropertyDescriptor(copied, "0");
    expect(property?.value).toEqual({ content: "original" });
    property!.value.content = "changed";
    expect(Object.getOwnPropertyDescriptor(view, "0")?.value).toEqual({
      content: "original",
    });
  });

  it("owns cyclic records, collection entries, native data and non-enumerable fields", () => {
    const shared = { value: "original" };
    const marker = Symbol("artifact");
    const original = {
      shared,
      map: new Map([[shared, new Set([shared])]]),
      date: new Date(1),
      pattern: /probe/g,
      bytes: new Uint8Array([1, 2]),
      self: null as unknown,
    };
    original.self = original;
    Object.defineProperty(original, marker, {
      value: shared,
      enumerable: false,
    });
    const copied = cloneHookData(original);
    expect(copied.self).toBe(copied);
    expect(copied.map.get(copied.shared)?.has(copied.shared)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(copied, marker)).toMatchObject({
      value: copied.shared,
      enumerable: false,
    });
    copied.shared.value = "changed";
    copied.date.setTime(2);
    copied.pattern.lastIndex = 2;
    copied.bytes[0] = 9;
    expect(shared.value).toBe("original");
    expect(original.date.getTime()).toBe(1);
    expect(original.pattern.lastIndex).toBe(0);
    expect([...original.bytes]).toEqual([1, 2]);
  });

  it("preserves the non-enumerable tool envelope marker", () => {
    const output = withPendingProposals(Object.freeze({ value: "original" }), [
      {
        id: "proposal",
        type: "plugin.data",
        sessionId: "session",
        turnId: "turn",
        source: { pluginId: "probe", runtimeId: "probe/main" },
        timestamp: "2026-09-19T00:00:00.000Z",
        payload: { namespace: "entries", key: "key", value: 1 },
      },
    ]);
    const copied = cloneHookData(output);
    expect(getToolContent(copied)).toEqual({ value: "original" });
    expect(getPendingProposals(copied)).toHaveLength(1);
    expect(getPendingProposals(copied)[0]).not.toBe(
      getPendingProposals(output)[0],
    );
  });

  it.each(["TurnStart", "TurnStop"] as const)(
    "rejects unsupported input with %s failure semantics without executing getters",
    async (event) => {
      const getter = vi.fn(() => "secret");
      const payload = Object.defineProperty({}, "value", {
        get: getter,
        enumerable: true,
      });
      const pipeline = createHookPipeline();
      const handler = vi.fn(async () => ({ action: "continue" as const }));
      pipeline.register({ id: "data", event, handler });
      const eventBus = createEventBus();
      const emit = vi.spyOn(eventBus, "emit");
      const result = await pipeline.run(
        event,
        { event, sessionId: "session", turnId: "turn" },
        payload,
        { eventBus },
      );
      expect(result.action).toBe(event === "TurnStop" ? "continue" : "abort");
      expect(getter).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            _subType: "hook.error",
            hookId: "data",
          }),
        }),
      );
      await eventBus.close();
    },
  );

  it.each([
    () => {},
    new SharedArrayBuffer(4),
    new Uint8Array(new SharedArrayBuffer(4)),
    new WeakMap(),
    new (class Data {
      value = 1;
    })(),
  ])("never shares unsupported values (%s)", (value) => {
    expect(() => cloneHookData({ value })).toThrow(TypeError);
  });

  it("rejects an unsupported replacement as a handler error", async () => {
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "replace",
      event: "TurnStart",
      async handler() {
        return { action: "continue", replace: { call: () => {} } };
      },
    });
    expect(
      await pipeline.run(
        "TurnStart",
        { event: "TurnStart", sessionId: "session", turnId: "turn" },
        {},
      ),
    ).toMatchObject({
      action: "abort",
      reason: "Hook data cannot contain functions",
    });
  });
});
