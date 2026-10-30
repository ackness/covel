// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { relayResponseBody } from "../model-relay-body.js";

afterEach(() => vi.useRealTimers());
function source() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const reader = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  }).getReader();
  return { reader, controller };
}
it("flushes a small chunk within 50ms even while the next read waits", async () => {
  vi.useFakeTimers();
  const { reader, controller } = source();
  const post = vi.fn(async () => true);
  const done = relayResponseBody(reader, post);
  controller.enqueue(new Uint8Array([1]));
  await vi.advanceTimersByTimeAsync(50);
  const callsAtDeadline = post.mock.calls.length;
  controller.close();
  await done;
  expect(callsAtDeadline).toBe(1);
});
it("coalesces buffered input after slow posts without reordering or parallel posts", async () => {
  vi.useFakeTimers();
  const { reader, controller } = source();
  const chunks: Uint8Array[] = [];
  let active = 0;
  let peak = 0;
  const done = relayResponseBody(reader, async (bytes) => {
    chunks.push(bytes);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 100));
    active--;
    return true;
  });
  for (let n = 0; n < 20; n++) {
    controller.enqueue(new Uint8Array([n]));
    await vi.advanceTimersByTimeAsync(10);
  }
  controller.close();
  await vi.runAllTimersAsync();
  expect(await done).toBe(true);
  expect(peak).toBe(1);
  expect(chunks.flatMap((c) => [...c])).toEqual(
    Array.from({ length: 20 }, (_, n) => n),
  );
  expect(chunks.length).toBeLessThanOrEqual(4);
});
it("bounds every post to 256 KiB and stops after a refused post", async () => {
  const { reader, controller } = source();
  controller.enqueue(new Uint8Array(700_000));
  controller.close();
  const sizes: number[] = [];
  expect(
    await relayResponseBody(reader, async (bytes) => {
      sizes.push(bytes.length);
      return sizes.length < 2;
    }),
  ).toBe(false);
  expect(sizes).toEqual([262144, 262144]);
});
it("keeps concurrent streams isolated and propagates read cancellation", async () => {
  vi.useFakeTimers();
  const a = source();
  const b = source();
  const pa = vi.fn(async () => true);
  const pb = vi.fn(async () => true);
  const first = relayResponseBody(a.reader, pa);
  const second = relayResponseBody(b.reader, pb);
  const aborted = expect(first).rejects.toThrow("cancelled");
  a.controller.enqueue(new Uint8Array([1]));
  b.controller.enqueue(new Uint8Array([2]));
  a.controller.error(new Error("cancelled"));
  await vi.advanceTimersByTimeAsync(50);
  b.controller.close();
  await second;
  await aborted;
  expect(pa).not.toHaveBeenCalled();
  expect(pb).toHaveBeenCalledExactlyOnceWith(new Uint8Array([2]));
});

it("preserves all bytes across maximum-size boundaries and drains EOF", async () => {
  const { reader, controller } = source();
  const input = Uint8Array.from({ length: 700_000 }, (_, n) => n % 251);
  controller.enqueue(input.subarray(0, 1));
  controller.enqueue(input.subarray(1));
  controller.close();
  const chunks: Uint8Array[] = [];
  expect(
    await relayResponseBody(reader, async (bytes) => {
      chunks.push(bytes);
      return true;
    }),
  ).toBe(true);
  expect(chunks.every((c) => c.length <= 262144)).toBe(true);
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(input));
});

it("propagates a failed POST without sending another chunk", async () => {
  const { reader, controller } = source();
  controller.enqueue(new Uint8Array(700_000));
  controller.close();
  const post = vi.fn(async () => {
    throw new Error("network failure");
  });
  await expect(relayResponseBody(reader, post)).rejects.toThrow(
    "network failure",
  );
  expect(post).toHaveBeenCalledOnce();
});

it("keeps one pending read during a slow POST and propagates cancellation before another POST", async () => {
  vi.useFakeTimers();
  const { reader, controller } = source();
  const read = vi.spyOn(reader, "read");
  let acknowledge!: (accepted: boolean) => void;
  const post = vi.fn(
    () => new Promise<boolean>((resolve) => (acknowledge = resolve)),
  );
  const done = relayResponseBody(reader, post);
  const cancelled = expect(done).rejects.toThrow("cancelled during POST");
  controller.enqueue(new Uint8Array([1]));
  await vi.advanceTimersByTimeAsync(50);
  expect(post).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(2);
  controller.error(new Error("cancelled during POST"));
  await vi.advanceTimersByTimeAsync(200);
  expect(read).toHaveBeenCalledTimes(2);
  expect(post).toHaveBeenCalledOnce();
  acknowledge(true);
  await cancelled;
  expect(post).toHaveBeenCalledOnce();
});
