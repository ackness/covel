import { describe, expect, it } from "vitest";
import {
  isHostVersionRange,
  satisfiesHostVersionRange,
} from "../src/utils/host-version-range.js";

describe("host version ranges", () => {
  it.each([
    ["0.0.45", ">=0.0.45", true],
    ["0.0.44", ">=0.0.45", false],
    ["0.1.0", ">=0.0.45 <0.1.0", false],
    ["0.0.99", ">=0.0.45 <0.1.0", true],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "=1.2.3", false],
    ["0.10.0", ">0.9.9", true],
    // A pre-release build of a version is inside the range that version is in.
    ["0.0.45-beta.1", ">=0.0.45", true],
  ])("%s against %s is %s", (host, range, expected) => {
    expect(satisfiesHostVersionRange(host, range)).toBe(expected);
  });

  it("tells an unreadable version or range apart from a mismatch", () => {
    expect(satisfiesHostVersionRange("dev", ">=0.0.45")).toBeNull();
    expect(satisfiesHostVersionRange("0.0.45", "^0.0.45")).toBeNull();
  });

  it("accepts only comparator lists", () => {
    expect(isHostVersionRange(">=0.0.45 <0.1.0")).toBe(true);
    expect(isHostVersionRange("^0.0.45")).toBe(false);
    expect(isHostVersionRange(">=0.0")).toBe(false);
    expect(isHostVersionRange("")).toBe(false);
  });
});
