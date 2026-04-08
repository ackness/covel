import { describe, it, expect, vi } from "vitest";
import { createEventBus } from "../src/event-bus.js";
import type { CovelEvent } from "../src/types.js";

describe("EventBus", () => {
  it("should emit and receive events", async () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.on("turn.start", handler);

    await bus.emit({ type: "turn.start", payload: { turnId: "t1" } });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].type).toBe("turn.start");
  });

  it("should support wildcard patterns", async () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.on("turn.*", handler);

    await bus.emit({ type: "turn.start", payload: null });
    await bus.emit({ type: "turn.input", payload: null });
    await bus.emit({ type: "session.start", payload: null });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("should support double wildcard **", async () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.on("**", handler);

    await bus.emit({ type: "turn.start", payload: null });
    await bus.emit({ type: "quest.completed", payload: null });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("should support single-segment wildcard", async () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.on("*.completed", handler);

    await bus.emit({ type: "quest.completed", payload: null });
    await bus.emit({ type: "combat.completed", payload: null });
    await bus.emit({ type: "combat.started", payload: null });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("should support once subscription", async () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.once("turn.start", handler);

    await bus.emit({ type: "turn.start", payload: null });
    await bus.emit({ type: "turn.start", payload: null });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("should support off to remove handler", async () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.on("turn.start", handler);

    await bus.emit({ type: "turn.start", payload: null });
    bus.off("turn.start", handler);
    await bus.emit({ type: "turn.start", payload: null });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("should support unsubscribe return value", async () => {
    const bus = createEventBus();
    const handler = vi.fn();
    const unsub = bus.on("turn.start", handler);

    await bus.emit({ type: "turn.start", payload: null });
    unsub();
    await bus.emit({ type: "turn.start", payload: null });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("should filter by category", async () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.on("turn.start", handler, { category: "trigger" });

    await bus.emit({
      type: "turn.start",
      payload: null,
      meta: { category: "trigger" },
    });
    await bus.emit({
      type: "turn.start",
      payload: null,
      meta: { category: "domain" },
    });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("should filter by source", async () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.on("**", handler, { source: { pluginId: "core-dice" } });

    await bus.emit({
      type: "dice.rolled",
      payload: null,
      source: { pluginId: "core-dice" },
    });
    await bus.emit({
      type: "quest.completed",
      payload: null,
      source: { pluginId: "core-quest" },
    });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("should isolate handler errors", async () => {
    const bus = createEventBus();
    const badHandler = vi.fn(() => {
      throw new Error("boom");
    });
    const goodHandler = vi.fn();
    bus.on("turn.start", badHandler);
    bus.on("turn.start", goodHandler);

    const result = await bus.emit({ type: "turn.start", payload: null });

    expect(goodHandler).toHaveBeenCalledOnce();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe("boom");
    expect(result.handlerCount).toBe(2);
  });

  it("should run middleware", async () => {
    const bus = createEventBus();
    const handler = vi.fn();
    const mwOrder: string[] = [];

    bus.use(async (_event, next) => {
      mwOrder.push("before");
      await next();
      mwOrder.push("after");
    });
    bus.on("turn.start", handler);

    await bus.emit({ type: "turn.start", payload: null });

    expect(mwOrder).toEqual(["before", "after"]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should stamp timestamp on emit", async () => {
    const bus = createEventBus();
    let received: CovelEvent | null = null;
    bus.on("test", (e) => { received = e; });

    await bus.emit({ type: "test", payload: null });

    expect(received).not.toBeNull();
    expect(received!.meta?.timestamp).toBeDefined();
  });
});

describe("ScopedEventBus", () => {
  it("should receive parent events", async () => {
    const bus = createEventBus();
    const scoped = bus.scope("test-scope");
    const handler = vi.fn();
    scoped.on("turn.start", handler);

    await bus.emit({ type: "turn.start", payload: null });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("should emit with default source", async () => {
    const bus = createEventBus();
    const scoped = bus.scope("test-scope", {
      defaultSource: { pluginId: "core-dice", runtimeId: "dice-roll" },
    });
    let received: CovelEvent | null = null;
    bus.on("dice.rolled", (e) => { received = e; });

    await scoped.emit({ type: "dice.rolled", payload: { total: 10 } });

    expect(received?.source?.pluginId).toBe("core-dice");
    expect(received?.source?.runtimeId).toBe("dice-roll");
  });

  it("should dispose all subscriptions", async () => {
    const bus = createEventBus();
    const scoped = bus.scope("test-scope");
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    scoped.on("turn.start", handler1);
    scoped.on("turn.input", handler2);

    scoped.dispose();

    await bus.emit({ type: "turn.start", payload: null });
    await bus.emit({ type: "turn.input", payload: null });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });

  it("should support nested scopes", async () => {
    const bus = createEventBus();
    const parent = bus.scope("parent");
    const child = parent.scope("child");
    const handler = vi.fn();
    child.on("test", handler);

    await bus.emit({ type: "test", payload: null });
    expect(handler).toHaveBeenCalledOnce();

    child.dispose();
    await bus.emit({ type: "test", payload: null });
    expect(handler).toHaveBeenCalledOnce();
  });
});
