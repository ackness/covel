import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLLMSlot,
  setLLMSlotCapForTests,
} from "../src/retry/llm-slots.js";

afterEach(() => {
  setLLMSlotCapForTests(undefined);
});

describe("acquireLLMSlot", () => {
  it("serializes callers beyond the cap in FIFO order", async () => {
    // Arrange
    setLLMSlotCapForTests(1);
    const order: string[] = [];

    // Act — first holds the slot; second and third must queue behind it.
    const first = await acquireLLMSlot();
    const second = acquireLLMSlot().then((slot) => {
      order.push("second");
      return slot;
    });
    const third = acquireLLMSlot().then((slot) => {
      order.push("third");
      return slot;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Assert — nobody advanced while the slot is held.
    expect(order).toEqual([]);
    first.release();
    (await second).release();
    (await third).release();
    expect(order).toEqual(["second", "third"]);
  });

  it("reports queue wait time so callers can extend their deadline", async () => {
    // Arrange
    setLLMSlotCapForTests(1);
    const first = await acquireLLMSlot();
    expect(first.waitedMs).toBeLessThan(20);

    // Act
    const queued = acquireLLMSlot();
    await new Promise((resolve) => setTimeout(resolve, 40));
    first.release();
    const second = await queued;

    // Assert
    expect(second.waitedMs).toBeGreaterThanOrEqual(30);
    second.release();
  });

  it("release is idempotent and never frees more than one waiter", async () => {
    // Arrange
    setLLMSlotCapForTests(1);
    const first = await acquireLLMSlot();
    let secondStarted = false;
    let thirdStarted = false;
    const second = acquireLLMSlot().then((slot) => {
      secondStarted = true;
      return slot;
    });
    const third = acquireLLMSlot().then((slot) => {
      thirdStarted = true;
      return slot;
    });

    // Act — double release must only admit ONE queued caller.
    first.release();
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Assert
    expect(secondStarted).toBe(true);
    expect(thirdStarted).toBe(false);
    (await second).release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdStarted).toBe(true);
    (await third).release();
  });

  it("cap 0 disables the gate entirely", async () => {
    // Arrange
    setLLMSlotCapForTests(0);

    // Act — many concurrent holders, none queued.
    const slots = await Promise.all(
      Array.from({ length: 10 }, () => acquireLLMSlot()),
    );

    // Assert
    for (const slot of slots) {
      expect(slot.waitedMs).toBeLessThan(20);
      slot.release();
    }
  });
});

describe("slot cancellation and handoff", () => {
  it("cancels a queued caller immediately without blocking surviving waiters", async () => {
    setLLMSlotCapForTests(1);
    const first = await acquireLLMSlot();
    const controller = new AbortController();
    const queued = acquireLLMSlot(controller.signal);
    const rejected = expect(queued).rejects.toMatchObject({
      name: "AbortError",
    });
    const survivor = acquireLLMSlot();
    controller.abort();
    await rejected;
    first.release();
    (await survivor).release();
    (await acquireLLMSlot()).release();
  });

  it("returns reserved capacity when cancellation races a handoff", async () => {
    setLLMSlotCapForTests(1);
    const first = await acquireLLMSlot();
    const controller = new AbortController();
    const queued = acquireLLMSlot(controller.signal);
    const rejected = expect(queued).rejects.toMatchObject({
      name: "AbortError",
    });
    first.release();
    controller.abort();
    await rejected;
    (await acquireLLMSlot()).release();
  });

  it("reserves a handed-off slot before a newcomer can acquire it", async () => {
    setLLMSlotCapForTests(1);
    const first = await acquireLLMSlot();
    const second = acquireLLMSlot();
    first.release();
    let newcomerStarted = false;
    const third = acquireLLMSlot().then((slot) => {
      newcomerStarted = true;
      return slot;
    });
    const holder = await second;
    await Promise.resolve();
    expect(newcomerStarted).toBe(false);
    holder.release();
    (await third).release();
  });

  it("rejects an already aborted caller without taking any capacity", async () => {
    setLLMSlotCapForTests(1);
    await expect(acquireLLMSlot(AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    (await acquireLLMSlot()).release();
  });
});
