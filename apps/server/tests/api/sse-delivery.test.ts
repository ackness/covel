import { afterEach, expect, it, vi } from "vitest";
import { SSEStreamingApi } from "hono/streaming";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import {
  closeSseDelivery,
  createBoundedSerialQueue,
} from "../../src/routes/api/sse-delivery.js";
import { emitSeq, makeApp, seedSession } from "./sse-test-utils.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("bounds and deduplicates a close that never settles", async () => {
  vi.useFakeTimers();
  const close = vi.fn(() => new Promise<void>(() => {}));
  const abort = vi.fn();
  const stream = { close, abort } as unknown as SSEStreamingApi;
  const closing = closeSseDelivery(stream);
  expect(closeSseDelivery(stream)).toBe(closing);
  await vi.advanceTimersByTimeAsync(2000);
  await closing;
  expect(close).toHaveBeenCalledOnce();
  expect(abort).toHaveBeenCalledOnce();
  await closeSseDelivery(stream);
  expect(close).toHaveBeenCalledOnce();
});

it("bounds total drain even while individual writes keep completing before their deadlines", async () => {
  vi.useFakeTimers();
  const fail = vi.fn();
  const queue = createBoundedSerialQueue({
    capacity: 256,
    onOverflow: fail,
    onError: fail,
  });
  const run = vi.fn(
    () => new Promise<void>((resolve) => setTimeout(resolve, 1500)),
  );
  for (let i = 0; i < 10; i++) queue.enqueue(run);
  const drain = queue.drain();
  await vi.advanceTimersByTimeAsync(2000);
  await drain;
  expect(run).toHaveBeenCalledTimes(2);
  expect(queue.pending()).toBe(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(queue.pending()).toBe(0);
  expect(fail).toHaveBeenCalledOnce();
});

it.each(["native-backpressure", "hung-connected"] as const)(
  "releases subscription pins, listeners, timers and connection budget after %s",
  async (mode) => {
    vi.useFakeTimers();
    const store = createMemoryStore();
    const bus = createEventBus();
    const sessionId = `sse-delivery-${mode}`;
    await seedSession(store, sessionId);
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const unsubs: Array<ReturnType<typeof vi.fn>> = [];
    const originalPin = bus.pin.bind(bus);
    vi.spyOn(bus, "pin").mockImplementation((id) => {
      const pin = originalPin(id);
      const release = vi.fn(pin.release);
      releases.push(release);
      return { epoch: pin.epoch, release };
    });
    for (const name of ["onEmit", "onReset"] as const) {
      const original = bus[name]!.bind(bus);
      // Both observer surfaces return the same cleanup contract.
      vi.spyOn(bus, name).mockImplementation((callback) => {
        const unsub = vi.fn(original(callback as never));
        unsubs.push(unsub);
        return unsub;
      });
    }
    const native = SSEStreamingApi.prototype.writeSSE;
    const instances: SSEStreamingApi[] = [];
    let started = 0;
    let settled = 0;
    const writes = vi
      .spyOn(SSEStreamingApi.prototype, "writeSSE")
      .mockImplementation(function (frame) {
        instances.push(this);
        started++;
        if (mode === "hung-connected") return new Promise<void>(() => {});
        return native.call(this, frame).finally(() => {
          settled++;
        });
      });
    const app = makeApp(store, bus);
    const response = await app.request(
      `/api/events/stream?sessionId=${sessionId}`,
    );
    expect(response.status).toBe(200);
    await vi.advanceTimersByTimeAsync(0);
    if (mode === "native-backpressure") {
      for (let i = 0; i < 20; i++) emitSeq(bus, sessionId, "state", i);
      await vi.advanceTimersByTimeAsync(0);
      expect(started - settled).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(instances.at(-1)?.aborted).toBe(true);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(unsubs).toHaveLength(2);
    for (const unsub of unsubs) expect(unsub).toHaveBeenCalledOnce();
    if (mode === "native-backpressure") expect(started).toBe(settled); // actual Hono reader.cancel released writer.write
    const before = started;
    emitSeq(bus, sessionId, "state", 99);
    await vi.advanceTimersByTimeAsync(30000);
    expect(started).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    await response.body?.cancel();
    writes.mockRestore();
    // More than the per-session budget over time, not eight permanently lost leases.
    for (let i = 0; i < 9; i++) {
      const next = await app.request(
        `/api/events/stream?sessionId=${sessionId}`,
      );
      expect(next.status).toBe(200);
      await next.body?.cancel();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(vi.getTimerCount()).toBe(0);
    await bus.close();
  },
);
