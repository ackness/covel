import { describe, it, expect, vi } from "vitest";
import {
  createTurnEmitter,
  createNoopTurnEmitter,
  type TurnEmitterStore,
} from "../src/trace/turn-emitter.js";
import type { EventBus } from "@covel/events";

function makeStoreSpy() {
  return {
    addTraceEvent: vi.fn(
      async (_record: Parameters<TurnEmitterStore["addTraceEvent"]>[0]) =>
        undefined,
    ),
  };
}

function makeBusSpy(): EventBus & {
  emitted: Array<{ type: string; payload: unknown }>;
} {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const bus: EventBus = {
    emit(ev: { payload: unknown }) {
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
  it("strips content from concealed runtimes before persisting or streaming", async () => {
    const store = makeStoreSpy();
    const bus = makeBusSpy();
    const emitter = createTurnEmitter({
      store,
      eventBus: bus,
      sessionId: "S",
      turnId: "T",
      concealedRuntimeIds: new Set(["planner/plot"]),
    });
    await emitter.emit("tool.calling", {
      runtimeId: "planner/plot",
      toolName: "plan",
      arguments: '{"payload":"spoiler"}',
    });
    await emitter.emit("tool.calling", {
      runtimeId: "narrator",
      toolName: "emit-event",
      arguments: '{"topic":"open"}',
    });

    const persisted = store.addTraceEvent.mock.calls.map(
      (call) =>
        (call as unknown as [{ payload: Record<string, unknown> }])[0].payload,
    );
    expect(persisted[0]).toMatchObject({
      concealed: true,
      runtimeId: "planner/plot",
      toolName: "plan",
    });
    expect(JSON.stringify(persisted[0])).not.toContain("spoiler");
    expect(JSON.stringify(bus.emitted[0])).not.toContain("spoiler");
    expect(persisted[1]).toMatchObject({ arguments: '{"topic":"open"}' });
  });

  it.each([false, true])(
    "isolates synchronous and asynchronous store failures and redacts fallback logs (async=%s)",
    async (asynchronous) => {
      const store = {
        addTraceEvent() {
          const error = new Error(
            "private database credential and player text",
          );
          if (asynchronous) return Promise.reject(error);
          throw error;
        },
      };
      const bus = makeBusSpy();
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const emitter = createTurnEmitter({
          store,
          eventBus: bus,
          sessionId: "S",
          turnId: "T",
          traceId: "trace",
        });
        await expect(
          emitter.emit("hook.fired", { hookName: "probe" }),
        ).resolves.toBeUndefined();
        expect(bus.emitted).toHaveLength(1);
        expect(warning).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            sessionId: "S",
            turnId: "T",
            traceId: "trace",
            type: "hook.fired",
          }),
        );
        expect(JSON.stringify(warning.mock.calls)).not.toContain(
          "private database credential and player text",
        );
      } finally {
        warning.mockRestore();
      }
    },
  );

  it("retains persistence when broadcasting fails without logging its error contents", async () => {
    const store = makeStoreSpy();
    const bus = makeBusSpy();
    bus.emit = () => {
      throw new Error("private broadcast content");
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const emitter = createTurnEmitter({
        store,
        eventBus: bus,
        sessionId: "S",
        turnId: "T",
      });
      await expect(
        emitter.emit("hook.rewrote", { diff: { value: "private payload" } }),
      ).resolves.toBeUndefined();
      expect(store.addTraceEvent).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sessionId: "S",
          turnId: "T",
          traceId: "T",
          type: "hook.rewrote",
        }),
      );
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(
        /private broadcast content|private payload/,
      );
    } finally {
      warning.mockRestore();
    }
  });

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
    const first = store.addTraceEvent.mock.calls[0]![0];
    const second = store.addTraceEvent.mock.calls[1]![0];
    expect(first!.type).toBe("tool.calling");
    expect(first!.sessionId).toBe("S");
    expect(first!.turnId).toBe("T");
    expect(first!.traceId).toBe("T");
    expect((first!.payload as { seq: number }).seq).toBe(0);
    expect((second!.payload as { seq: number }).seq).toBe(1);

    expect(bus.emitted).toHaveLength(2);
    expect(bus.emitted[0]!.type).toBe("tool.calling");
    expect(bus.emitted[1]!.type).toBe("tool.completed");
    // flowId defaults to the (fallback) traceId so /api/traces never returns "".
    expect((first!.payload as { flowId?: string }).flowId).toBe("T");
  });

  it("uses the explicit traceId for trace_events and sets payload.flowId = traceId", async () => {
    const store = makeStoreSpy();
    const emitter = createTurnEmitter({
      store,
      sessionId: "S",
      turnId: "T",
      traceId: "trace-xyz",
    });

    await emitter.emit("tool.calling", { toolName: "a" });

    const row = store.addTraceEvent.mock.calls[0]![0];
    // Persisted traceId is the explicit one (not the turnId fallback), so an
    // SSE envelope built from the same traceId correlates with /api/traces rows.
    expect(row!.traceId).toBe("trace-xyz");
    expect(row!.turnId).toBe("T");
    expect((row!.payload as { flowId?: string }).flowId).toBe("trace-xyz");
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

    await expect(emitter.emit("x" as never, {})).resolves.toBeUndefined();
    expect(bus.emitted).toHaveLength(1);
  });

  it("works with no eventBus (persist-only)", async () => {
    const store = makeStoreSpy();
    const emitter = createTurnEmitter({ store, sessionId: "S", turnId: "T" });
    await emitter.emit("y" as never, { a: 1 });
    expect(store.addTraceEvent).toHaveBeenCalledTimes(1);
  });

  it("noop emitter is a no-op", async () => {
    const e = createNoopTurnEmitter("S", "T");
    await expect(e.emit("anything" as never, {})).resolves.toBeUndefined();
  });
});
