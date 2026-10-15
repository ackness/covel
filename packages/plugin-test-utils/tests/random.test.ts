import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRandom, restartSessionRandom } from "@covel/runtime";
import { makeRandom } from "@covel/plugin-test-utils";

const scope = { sessionId: "test-random", pluginId: "dice", stream: "roll" };

afterEach(() => {
  vi.unstubAllEnvs();
  restartSessionRandom(scope.sessionId);
});

describe("makeRandom range validation", () => {
  it.each([
    [1, 1],
    [3, 1],
    [1.5, 3],
    [1, 3.5],
    [NaN, 3],
    [1, NaN],
    [0, Infinity],
    [-Infinity, 1],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2],
    [Number.MIN_SAFE_INTEGER - 1, 0],
    [0, 2 ** 48],
    [0, 2 ** 48 + 1],
    [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ])("rejects (%s, %s) with the same error from every source", (min, max) => {
    const error = new RangeError(
      `ctx.random.int needs safe integers with min < max: ${min}, ${max}`,
    );
    for (const seed of ["", "range-test"]) {
      vi.stubEnv("COVEL_RANDOM_SEED", seed);
      for (const random of [createPluginRandom(scope), makeRandom()]) {
        expect(() => random.int(min, max)).toThrowError(RangeError);
        expect(() => random.int(min, max)).toThrowError(error);
      }
    }
  });

  it.each([
    [1, 2],
    [-10, 10],
    [Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER + 1],
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER],
    [0, 2 ** 48 - 1],
  ])("accepts the boundary range (%s, %s) in every source", (min, max) => {
    for (const seed of ["", "range-test"]) {
      vi.stubEnv("COVEL_RANDOM_SEED", seed);
      for (const random of [createPluginRandom(scope), makeRandom()]) {
        const value = random.int(min, max);
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(min);
        expect(value).toBeLessThan(max);
      }
    }
  });

  it("rejects invalid draws without advancing the test sequence", () => {
    const random = makeRandom(7);
    expect(() => random.int(1, 1)).toThrow(RangeError);
    const expected = makeRandom(7);
    expect(Array.from({ length: 5 }, () => random.int(1, 21))).toEqual(
      Array.from({ length: 5 }, () => expected.int(1, 21)),
    );
  });
});
