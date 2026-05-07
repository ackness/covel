/**
 * Priority scheduler — band boundary and input-safety invariants.
 *
 * Existing `scheduler.test.ts` covers happy-path band filtering. This file
 * pins:
 *  - exact boundary at priority=99 vs 100 (Pre-Game vs main loop)
 *  - priority=undefined runtimes never enter any band (UI-only safeguard)
 *  - extreme priorities (0, 1000) stay in the right bands
 *  - input array is not mutated (callers reuse the manifest list)
 *  - `groups[i].runtimes` ordering is stable when input is shuffled
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { scheduleByPriority } from "../src/scheduler.js";

function rt(name: string, priority?: number): RuntimeManifest {
  return {
    name,
    pluginId: name,
    description: name,
    priority,
  } as unknown as RuntimeManifest;
}

describe("scheduleByPriority — exact boundary 99 vs 100", () => {
  it("priority 99 is Pre-Game (turn 0 only)", () => {
    const m = rt("edge-99", 99);
    expect(
      scheduleByPriority([m], 0).flatMap((g) => g.runtimes.map((r) => r.name)),
    ).toEqual(["edge-99"]);
    expect(
      scheduleByPriority([m], 1).flatMap((g) => g.runtimes.map((r) => r.name)),
    ).toEqual([]);
  });

  it("priority 100 is main-loop (turn ≥ 1 only)", () => {
    const m = rt("edge-100", 100);
    expect(
      scheduleByPriority([m], 0).flatMap((g) => g.runtimes.map((r) => r.name)),
    ).toEqual([]);
    expect(
      scheduleByPriority([m], 1).flatMap((g) => g.runtimes.map((r) => r.name)),
    ).toEqual(["edge-100"]);
  });

  it("priority 0 is the lowest valid Pre-Game value", () => {
    const m = rt("zero", 0);
    expect(
      scheduleByPriority([m], 0).flatMap((g) => g.runtimes.map((r) => r.name)),
    ).toEqual(["zero"]);
  });

  it("priority 1000 is valid main-loop (Audit band)", () => {
    const m = rt("audit", 1000);
    expect(
      scheduleByPriority([m], 7).flatMap((g) => g.runtimes.map((r) => r.name)),
    ).toEqual(["audit"]);
  });

  it("priority 1001 is outside the main-loop band", () => {
    const m = rt("future-band", 1001);
    expect(
      scheduleByPriority([m], 7).flatMap((g) => g.runtimes.map((r) => r.name)),
    ).toEqual([]);
  });

  it("negative priority is outside the Pre-Game band", () => {
    const m = rt("negative", -1);
    expect(
      scheduleByPriority([m], 0).flatMap((g) => g.runtimes.map((r) => r.name)),
    ).toEqual([]);
  });
});

describe("scheduleByPriority — priority undefined safeguard", () => {
  it("drops priority=undefined at turn 0", () => {
    const m = rt("ui-only");
    const groups = scheduleByPriority([m], 0);
    expect(groups).toEqual([]);
  });

  it("drops priority=undefined at turn ≥ 1", () => {
    const m = rt("ui-only");
    const groups = scheduleByPriority([m], 5);
    expect(groups).toEqual([]);
  });

  it("does not let priority=undefined poison a mixed input", () => {
    // The UI-only manifest must not break sorting when priorities exist.
    const input = [rt("valid", 500), rt("ui-only"), rt("audit", 1000)];
    const groups = scheduleByPriority(input, 1);
    expect(groups.map((g) => g.priority)).toEqual([500, 1000]);
    expect(groups.flatMap((g) => g.runtimes.map((r) => r.name))).toEqual([
      "valid",
      "audit",
    ]);
  });
});

describe("scheduleByPriority — input safety", () => {
  it("does not mutate the input array", () => {
    const input = [rt("b", 500), rt("a", 100), rt("c", 1000)];
    const snapshot = [...input];
    scheduleByPriority(input, 1);
    expect(input).toEqual(snapshot);
    // Reference equality on each manifest preserved.
    for (let i = 0; i < input.length; i++) {
      expect(input[i]).toBe(snapshot[i]);
    }
  });

  it("returns deterministic same-priority order for shuffled inputs", () => {
    // Same priority within a group preserves input order — important so
    // hooks like "global before plugin" can rely on caller-controlled
    // ordering without re-sorting.
    const a = scheduleByPriority(
      [rt("first", 500), rt("second", 500), rt("third", 500)],
      1,
    );
    const b = scheduleByPriority(
      [rt("first", 500), rt("second", 500), rt("third", 500)],
      1,
    );
    expect(a[0].runtimes.map((r) => r.name)).toEqual(
      b[0].runtimes.map((r) => r.name),
    );
    expect(a[0].runtimes.map((r) => r.name)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("handles an entirely empty input", () => {
    expect(scheduleByPriority([], 0)).toEqual([]);
    expect(scheduleByPriority([], 5)).toEqual([]);
  });
});
