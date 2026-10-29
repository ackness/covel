// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStreamPump } from "../session-bridge-stream.js";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup() {
  let value: { seq: number; text: string } | null = { seq: 1, text: "" };
  const send = vi.fn();
  const resync = vi.fn();
  const pump = createStreamPump({
    read: () => value,
    send,
    resync,
    intervalMs: 100,
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer),
  });
  pump.baseline(1, 0);
  return {
    pump,
    send,
    resync,
    update: (next: typeof value) => {
      value = next;
    },
  };
}
it("coalesces 50 appends into at most two sends with no lost text", () => {
  const { pump, send, update } = setup();
  for (let index = 1; index <= 50; index++) {
    update({ seq: 1, text: "x".repeat(index) });
    pump.notify();
    vi.advanceTimersByTime(2);
  }
  vi.advanceTimersByTime(100);
  expect(send.mock.calls.length).toBeLessThanOrEqual(2);
  expect(send.mock.calls.map(([message]) => message.append).join("")).toBe(
    "x".repeat(50),
  );
});
it("sends the tail immediately when a placeholder disappears, then resyncs once", () => {
  const { pump, send, resync, update } = setup();
  update({ seq: 1, text: "tail" });
  pump.notify();
  update(null);
  pump.flush();
  pump.flush();
  expect(send).toHaveBeenCalledExactlyOnceWith({ seq: 1, append: "tail" });
  expect(resync).toHaveBeenCalledTimes(1);
});
it.each([
  { seq: 2, text: "new" },
  { seq: 1, text: "x" },
])("resyncs on new sequence or shorter text: %j", (next) => {
  const { pump, send, resync, update } = setup();
  pump.baseline(1, 3);
  update(next);
  pump.flush();
  pump.flush();
  expect(resync).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
});
it("full push baselines prevent duplicates", () => {
  const { pump, send, update } = setup();
  update({ seq: 1, text: "oldnew" });
  pump.notify();
  pump.baseline(1, 6);
  vi.advanceTimersByTime(100);
  expect(send).not.toHaveBeenCalled();
  update({ seq: 1, text: "oldnewtail" });
  pump.flush();
  expect(send).toHaveBeenCalledExactlyOnceWith({ seq: 1, append: "tail" });
});
it("disposes timers and ignores later notifications", () => {
  const { pump, send, update } = setup();
  update({ seq: 1, text: "later" });
  pump.notify();
  pump.dispose();
  vi.advanceTimersByTime(1000);
  pump.notify();
  pump.flush();
  expect(send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("resyncs only once when a new sequence disappears before its flush", () => {
  const { pump, send, resync, update } = setup();
  update({ seq: 2, text: "new" });
  pump.notify();
  update(null);
  pump.flush();
  expect(resync).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});
