import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function markerCounts(files) {
  return new Map(
    files.flatMap(([file, text]) => {
      const count = [...text.matchAll(/\bponytail:/g)].length;
      return count ? [[file, count]] : [];
    }),
  );
}

function ledgerCounts(text) {
  const counts = new Map();
  for (const line of text.split("\n")) {
    const cells = line.split("|").slice(1, -1);
    // Limit rows have location, accepted limit and reconsideration columns.
    // The separate oversized-module table has only two columns.
    if (cells.length < 3) continue;
    const file = cells[0]
      ?.trim()
      .match(/^`((?:apps|packages|plugins)\/[^`]+)`$/)?.[1];
    if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

function ledgerProblems(markers, ledger) {
  return [...new Set([...markers.keys(), ...ledger.keys()])]
    .sort()
    .flatMap((file) => {
      const expected = markers.get(file) ?? 0;
      const actual = ledger.get(file) ?? 0;
      return expected === actual
        ? []
        : [`${file}: ${expected} marker(s), ${actual} ledger row(s)`];
    });
}

test("the ledger counts individual markers, including several in one file", () => {
  const file = "packages/example/src/limits.ts";
  const markers = markerCounts([
    [file, "// ponytail: first limit\n// ponytail: second limit\n"],
  ]);
  const row = `| \`${file}\` | Accepted limit | Reconsider when needed |\n`;
  assert.deepEqual(ledgerProblems(markers, ledgerCounts(row.repeat(2))), []);
  assert.deepEqual(ledgerProblems(markers, ledgerCounts(row)), [
    `${file}: 2 marker(s), 1 ledger row(s)`,
  ]);
  assert.deepEqual(ledgerProblems(markers, ledgerCounts(row.repeat(3))), [
    `${file}: 2 marker(s), 3 ledger row(s)`,
  ]);
  assert.deepEqual(ledgerProblems(new Map(), ledgerCounts(row)), [
    `${file}: 0 marker(s), 1 ledger row(s)`,
  ]);
  assert.deepEqual(ledgerProblems(markers, new Map()), [
    `${file}: 2 marker(s), 0 ledger row(s)`,
  ]);
  assert.deepEqual(ledgerCounts(`| \`${file}\` | 900 |\n`), new Map());
});

test("every ponytail marker has exactly one ledger row in each language", () => {
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps",
      "packages",
      "plugins",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => file && existsSync(path.join(root, file)));
  const markers = markerCounts(
    files.map((file) => [file, readFileSync(path.join(root, file), "utf8")]),
  );
  assert.ok(markers.size > 0, "the source scan must find the current markers");
  for (const page of [
    "docs/internals/technical-debt.md",
    "docs/en/internals/technical-debt.md",
  ]) {
    assert.deepEqual(
      ledgerProblems(
        markers,
        ledgerCounts(readFileSync(path.join(root, page), "utf8")),
      ),
      [],
      `${page}: update the ledger with every added or removed ponytail marker`,
    );
  }
});
