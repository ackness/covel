import { describe, expect, it } from "vitest";
import guard from "../runtimes/plot/guard.js";

describe("plot guard", () => {
  it("answers with an empty plan unless the planner setting is on", async () => {
    for (const userSettings of [undefined, { planner: false }]) {
      expect(await guard({ recursionDepth: 0, userSettings })).toMatchObject({
        skip: true,
        events: [],
      });
    }
    expect(
      await guard({ recursionDepth: 0, userSettings: { planner: true } }),
    ).toEqual({ skip: false });
  });

  it("leaves planning to the outer narrative execution", async () => {
    expect(
      await guard({ recursionDepth: 1, userSettings: { planner: true } }),
    ).toMatchObject({ skip: true, events: [] });
  });
});
