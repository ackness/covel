import { describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "../src/errors.js";

describe("isUniqueConstraintError", () => {
  it("recognizes PostgreSQL unique violations through wrapped causes", () => {
    const driverError = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    const wrapped = new Error("query failed", {
      cause: new Error("driver failed", { cause: driverError }),
    });

    expect(isUniqueConstraintError(wrapped)).toBe(true);
  });

  it("recognizes bundled SQLite unique violation codes", () => {
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(
      true,
    );
  });

  it("returns false for unrelated and cyclic cause chains", () => {
    const first: { code: string; cause?: unknown } = { code: "XX000" };
    const second: { cause?: unknown } = { cause: first };
    first.cause = second;

    expect(isUniqueConstraintError(first)).toBe(false);
    expect(isUniqueConstraintError(new Error("plain failure"))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
});
