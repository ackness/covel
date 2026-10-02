import { describe, expect, it } from "vitest";
import guard from "../runtimes/plot/guard.js";

describe("plot guard", () => {
  it("skips unless the planner setting is on", async () => {
    expect(await guard({ recursionDepth: 0 })).toMatchObject({ skip: true });
    expect(
      await guard({ recursionDepth: 0, userSettings: { planner: false } }),
    ).toMatchObject({ skip: true });
    expect(
      await guard({ recursionDepth: 0, userSettings: { planner: true } }),
    ).toEqual({ skip: false });
  });

  it("leaves planning to the outer narrative execution", async () => {
    expect(
      await guard({ recursionDepth: 1, userSettings: { planner: true } }),
    ).toMatchObject({ skip: true });
  });
});
