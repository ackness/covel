import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROLE_ACTION_KINDS } from "../src/index.js";

const PAGES = [
  "../../../docs/reference/world-model.md",
  "../../../docs/en/reference/world-model.md",
].map((page) => path.resolve(import.meta.dirname, page));

/**
 * The seat-role table of a world-model page, as role → base kinds: the table
 * right above the line that names `ROLE_ACTION_KINDS`.
 */
function roleTable(page: string): Record<string, string[]> {
  const lines = readFileSync(page, "utf8").split(/\r?\n/);
  const note = lines.findIndex((line) => line.includes("`ROLE_ACTION_KINDS`"));
  expect(note, `${page} never names ROLE_ACTION_KINDS`).toBeGreaterThan(0);
  const rows: string[] = [];
  for (const line of lines.slice(0, note).reverse()) {
    if (line.startsWith("|")) rows.unshift(line);
    else if (rows.length > 0) break;
  }
  const table: Record<string, string[]> = {};
  // The header and its separator come first.
  for (const row of rows.slice(2)) {
    const [role, kinds] = row
      .split("|")
      .slice(1, -1)
      .map((cell) =>
        [...cell.matchAll(/`([^`]+)`/g)].flatMap((match) =>
          match[1] !== undefined ? [match[1]] : [],
        ),
      );
    const name = role?.[0];
    if (name) table[name] = kinds ?? [];
  }
  return table;
}

describe("seat-role documentation", () => {
  it.each(PAGES)("matches ROLE_ACTION_KINDS in %s", (page) => {
    expect(
      roleTable(page),
      "update the seat-role table of world-model.md (zh and en)",
    ).toEqual(
      Object.fromEntries(
        Object.entries(ROLE_ACTION_KINDS).map(([role, kinds]) => [
          role,
          [...kinds],
        ]),
      ),
    );
  });
});
