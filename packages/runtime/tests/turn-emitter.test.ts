import { describe, it, expect, vi } from "vitest";
import {
  createTurnEmitter,
  createNoopTurnEmitter,
} from "../src/turn-emitter.js";
import type { EventBus } from "@covel/events";

function makeStoreSpy() {
  return { addTraceEvent: vi.fn(async () => undefined) };
}

function makeBusSpy(): EventBus & {
  emitted: Array<{ type: string; payload: unknown }>;
} {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const bus: EventBus = {
    emit(ev) {
      emitted.push({
        type: String((ev.payload as Record<string, unknown>)._subType ?? ""),
        payload: ev.payload,
      });
    },
    onEmit: () => () => undefined,
  } as unknown as EventBus;
  return Object.assign(bus, { emitted });
}

describe("TurnEmitter", () => {
  it("persists to store and broadcasts on eventBus with monotonic seq", async () => {
    const store = makeStoreSpy();
    const bus = makeBusSpy();
    const emitter = createTurnEmitter({
      store,
      eventBus: bus,
      sessionId: "S",
      turnId: "T",
    });

    await emitter.emit("tool.calling", { toolName: "a" });
    await emitter.emit("tool.completed", { toolName: "a" });

    expect(store.addTraceEvent).toHaveBeenCalledTimes(2);
    const first = store.addTraceEvent.mock.calls[0][0];
    const second = store.addTraceEvent.mock.calls[1][0];
    expect(first.type).toBe("tool.calling");
    expect(first.sessionId).toBe("S");
    expect(first.turnId).toBe("T");
    expect(first.traceId).toBe("T");
    expect((first.payload as { seq: number }).seq).toBe(0);
    expect((second.payload as { seq: number }).seq).toBe(1);

    expect(bus.emitted).toHaveLength(2);
    expect(bus.emitted[0].type).toBe("tool.calling");
    expect(bus.emitted[1].type).toBe("tool.completed");
  });

  it("tolerates store failure (warns but does not throw)", async () => {
    const store = {
      addTraceEvent: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const bus = makeBusSpy();
    const emitter = createTurnEmitter({
      store,
      eventBus: bus,
      sessionId: "S",
      turnId: "T",
    });

    await expect(emitter.emit("x", {})).resolves.toBeUndefined();
    expect(bus.emitted).toHaveLength(1);
  });

  it("works with no eventBus (persist-only)", async () => {
    const store = makeStoreSpy();
    const emitter = createTurnEmitter({ store, sessionId: "S", turnId: "T" });
    await emitter.emit("y", { a: 1 });
    expect(store.addTraceEvent).toHaveBeenCalledTimes(1);
  });

  it("noop emitter is a no-op", async () => {
    const e = createNoopTurnEmitter("S", "T");
    await expect(e.emit("anything", {})).resolves.toBeUndefined();
  });
});
