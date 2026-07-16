import { describe, expect, it, vi } from "vitest";
import {
  createBoundedSerialQueue,
  createConnectionBudget,
} from "../../src/routes/api/subscribe.js";

describe("SSE resource bounds", () => {
  it("enforces both per-session and global connection budgets with idempotent release", () => {
    const budget = createConnectionBudget({ maxTotal: 2, maxPerSession: 1 });
    const first = budget.reserve("session-a");
    expect(first.ok).toBe(true);
    expect(budget.reserve("session-a")).toEqual({
      ok: false,
      reason: "session",
    });

    const second = budget.reserve("session-b");
    expect(second.ok).toBe(true);
    expect(budget.reserve("session-c")).toEqual({
      ok: false,
      reason: "global",
    });

    if (first.ok) {
      first.release();
      first.release();
    }
    const replacement = budget.reserve("session-c");
    expect(replacement.ok).toBe(true);
    if (second.ok) second.release();
    if (replacement.ok) replacement.release();
    expect(budget.active()).toBe(0);
  });

  it("serializes writes and closes safely when the bounded queue overflows", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const overflow = vi.fn();
    const queue = createBoundedSerialQueue({
      capacity: 2,
      onOverflow: overflow,
    });

    expect(
      queue.enqueue(async () => {
        order.push("first:start");
        await firstGate;
        order.push("first:end");
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(
      queue.enqueue(async () => {
        order.push("second");
      }),
    ).toBe(true);
    expect(
      queue.enqueue(async () => {
        order.push("third");
      }),
    ).toBe(false);
    expect(overflow).toHaveBeenCalledTimes(1);

    releaseFirst();
    await queue.drain();
    expect(order).toEqual(["first:start", "first:end"]);
    expect(queue.pending()).toBe(0);
  });
});
