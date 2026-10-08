import { DatabaseSync } from "node:sqlite";
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

  it("recognizes SQLite primary-key and unique violations, not other constraints", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT UNIQUE, note TEXT NOT NULL)",
    );
    db.exec("INSERT INTO t VALUES ('a', 'x', 'n')");
    const failure = (sql: string): unknown => {
      try {
        db.exec(sql);
      } catch (error) {
        return error;
      }
      throw new Error(`expected ${sql} to fail`);
    };
    try {
      const duplicateKey = failure("INSERT INTO t VALUES ('a', 'y', 'n')");
      const duplicateName = failure("INSERT INTO t VALUES ('b', 'x', 'n')");
      const missingNote = failure("INSERT INTO t VALUES ('c', 'z', NULL)");
      expect(isUniqueConstraintError(duplicateKey)).toBe(true);
      expect(
        isUniqueConstraintError(
          new Error("query failed", { cause: duplicateName }),
        ),
      ).toBe(true);
      expect(isUniqueConstraintError(missingNote)).toBe(false);
    } finally {
      db.close();
    }
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
