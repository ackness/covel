import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAllowedCpuList } from "../e2e-cpu-list.mjs";

test("CPU selection respects allowed ranges, disjoint IDs and singleton hosts", () => {
  for (const [list, expected] of [
    ["0-3", "0,1"],
    ["4-5,8,10-12", "4,5"],
    ["4,8-12", "4,8"],
    ["17", "17"],
    ["8-8", "8"],
    ["20-1000000", "20,21"],
  ]) {
    assert.equal(
      parseAllowedCpuList(`Name:\tnode\nCpus_allowed_list:\t${list}\n`),
      expected,
    );
  }
});

test("CPU selection rejects missing, empty or malformed affinity without fallback", () => {
  assert.throws(() => parseAllowedCpuList("Name:\tnode\n"), /Missing/);
  assert.throws(
    () => parseAllowedCpuList("Cpus_allowed_list: 0\nCpus_allowed_list: 1"),
    /duplicate/,
  );
  for (const list of [
    "",
    " ",
    "3-1",
    "0-3,8-4",
    "1,",
    ",1",
    "1,,2",
    "-1",
    "1-a",
    "1-2-3",
    "1 2",
    "1.5",
    "a",
    "0,0",
    "2,1",
    "9007199254740992",
  ]) {
    assert.throws(
      () => parseAllowedCpuList(`Cpus_allowed_list:\t${list}\n`),
      undefined,
      list,
    );
  }
});

test(
  "Linux CLI uses the tested parser against its actual allowed cpuset",
  { skip: process.platform !== "linux" },
  () => {
    const expected = parseAllowedCpuList(
      readFileSync("/proc/self/status", "utf8"),
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../e2e-cpu-list.mjs", import.meta.url))],
      { encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  },
);
