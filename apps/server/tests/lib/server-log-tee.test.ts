import { describe, expect, it } from "vitest";
import { classifyServerStreamLine } from "../../src/server-log-tee.js";

describe("classifyServerStreamLine", () => {
  it("preserves explicitly marked stderr warnings as warn", () => {
    expect(
      classifyServerStreamLine(
        "stderr",
        "[covel:warn] [runtime-retry] narrator attempt=1",
      ),
    ).toEqual({
      level: "warn",
      message: "[runtime-retry] narrator attempt=1",
    });
  });

  it("keeps unmarked stderr as error and stdout as info", () => {
    expect(classifyServerStreamLine("stderr", "fatal").level).toBe("error");
    expect(classifyServerStreamLine("stdout", "ready").level).toBe("info");
  });
});
