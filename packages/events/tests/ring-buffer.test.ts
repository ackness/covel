import { describe, it, expect } from "vitest";
import { RingBuffer } from "../src/ring-buffer.js";

describe("RingBuffer", () => {
  it("returns items oldest-first before reaching capacity", () => {
    const buf = new RingBuffer<number>(4);
    buf.push(1);
    buf.push(2);
    buf.push(3);

    expect(buf.size).toBe(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  it("overwrites the oldest item once full and preserves order", () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 1; i <= 7; i += 1) buf.push(i);

    expect(buf.size).toBe(3);
    expect(buf.toArray()).toEqual([5, 6, 7]);
  });

  it("wraps correctly across many multiples of capacity", () => {
    const buf = new RingBuffer<number>(5);
    for (let i = 0; i < 1003; i += 1) buf.push(i);

    expect(buf.toArray()).toEqual([998, 999, 1000, 1001, 1002]);
  });

  it("throws on a non-positive or non-integer capacity", () => {
    expect(() => new RingBuffer(0)).toThrow(/positive integer/);
    expect(() => new RingBuffer(-1)).toThrow(/positive integer/);
    expect(() => new RingBuffer(1.5)).toThrow(/positive integer/);
  });
});
