import { describe, expect, it } from "vitest";
import {
  projectStoryOperationFailures,
  storyOperationFailuresSchema,
} from "../src/index.js";

describe("story operation failure projection", () => {
  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    null,
    undefined,
  ])("rejects invalid count %s", (count) => {
    expect(storyOperationFailuresSchema.safeParse({ count }).success).toBe(
      false,
    );
    expect(
      projectStoryOperationFailures({
        role: "assistant",
        kind: "story",
        operationFailures: { count },
      }),
    ).toEqual({});
  });
  it("returns only a fresh safe value for public assistant stories", () => {
    const value = { count: 2 };
    expect(
      projectStoryOperationFailures({
        role: "assistant",
        kind: "story",
        operationFailures: value,
      }),
    ).toEqual({ operationFailures: value });
    expect(
      projectStoryOperationFailures({
        role: "assistant",
        kind: "story",
        operationFailures: value,
      }).operationFailures,
    ).not.toBe(value);
    for (const role of ["system", "user"])
      expect(
        projectStoryOperationFailures({
          role,
          kind: "story",
          operationFailures: value,
        }),
      ).toEqual({});
    expect(
      projectStoryOperationFailures({
        role: "assistant",
        kind: "plugin",
        operationFailures: value,
      }),
    ).toEqual({});
    expect(
      projectStoryOperationFailures({
        role: "assistant",
        kind: "story",
        operationFailures: { count: 2, summary: "PRIVATE-SUMMARY" },
      }),
    ).toEqual({});
    expect(
      storyOperationFailuresSchema.parse({ count: Number.MAX_SAFE_INTEGER }),
    ).toEqual({ count: Number.MAX_SAFE_INTEGER });
  });
});
