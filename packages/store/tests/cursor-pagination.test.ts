/**
 * Unit tests for the keyset-cursor pure functions.
 *
 * The critical invariant: `sortByCursorAsc` (the memory/idb tie-break) must
 * order `id` by CODE-UNIT (byte) order, identical to `applyCursorPage`'s own
 * `<` and to SQLite's BINARY collation — NOT `localeCompare`. `localeCompare`
 * orders "alpha" before "Zeta"; byte order puts "Zeta" first (0x5A < 0x61). A
 * mismatch would make memory/idb pick a different row than the SQL backends for
 * the same same-`createdAt` cursor page (a store-backend-parity bug). Tested
 * directly here (not through a DB backend) so the guard holds regardless of any
 * backend's SQL collation.
 */

import { describe, it, expect } from "vitest";
import { applyCursorPage, sortByCursorAsc } from "../src/common/pagination.js";

const T = "2026-01-01T00:00:00.000Z";
const row = (id: string, createdAt = T) => ({ id, createdAt });

describe("sortByCursorAsc", () => {
  it("breaks createdAt ties by byte order, not localeCompare", () => {
    const sorted = sortByCursorAsc([row("alpha-2"), row("Zeta-1")]);
    // Byte order: "Zeta-1" (0x5A…) < "alpha-2" (0x61…).
    expect(sorted.map((r) => r.id)).toEqual(["Zeta-1", "alpha-2"]);
    // Sanity: this is the case that distinguishes byte order from localeCompare.
    expect("Zeta-1".localeCompare("alpha-2")).toBeGreaterThan(0);
  });

  it("orders by createdAt first, then id", () => {
    const sorted = sortByCursorAsc([
      row("z", "2026-01-01T00:00:02.000Z"),
      row("a", "2026-01-01T00:00:01.000Z"),
      row("b", "2026-01-01T00:00:01.000Z"),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "z"]);
  });
});

describe("applyCursorPage", () => {
  const asc = sortByCursorAsc([row("Zeta-1"), row("alpha-2"), row("beta-3")]);

  it("returns the newest window oldest-first with no cursor", () => {
    expect(applyCursorPage(asc, { limit: 2 }).map((r) => r.id)).toEqual([
      "alpha-2",
      "beta-3",
    ]);
  });

  it("pages strictly older than the (createdAt,id) cursor", () => {
    const older = applyCursorPage(asc, {
      limit: 5,
      before: { createdAt: T, id: "alpha-2" },
    });
    // Only "Zeta-1" is byte-strictly-before "alpha-2" at the same createdAt.
    expect(older.map((r) => r.id)).toEqual(["Zeta-1"]);
  });

  it("returns [] for a non-positive limit", () => {
    expect(applyCursorPage(asc, { limit: 0 })).toEqual([]);
    expect(applyCursorPage(asc, { limit: -1 })).toEqual([]);
  });
});
