import assert from "node:assert/strict";
import { test } from "node:test";
import BalancedSharding, { fileWeight, shardFiles } from "../e2e-sharding.mjs";

test("new files remain eligible and added cases scale a measured file's weight", () => {
  assert.equal(fileWeight("chromium/new.spec.ts", 2), 6);
  assert.equal(fileWeight("chromium-dev/new.spec.ts", 2), 18);
  const key = "chromium-dev/world-dimension-authoring.spec.ts";
  assert.ok(
    fileWeight(key, 1) > 9,
    "measured slow single-test files carry their actual cost",
  );
  assert.equal(fileWeight(key, 2), 2 * fileWeight(key, 1));
});

test("weighted shards are deterministic, disjoint, complete and keep files intact", () => {
  const files = Array.from({ length: 32 }, (_, index) => ({
    key: `file-${index}`,
    weight: index < 8 ? 3 : 1,
  }));
  const shards = shardFiles(files, 4);
  assert.deepEqual(shardFiles([...files].reverse(), 4), shards);
  assert.equal(
    new Set(shards.flatMap((shard) => shard.files)).size,
    files.length,
  );
  assert.deepEqual(
    shards.map((shard) => shard.weight),
    [12, 12, 12, 12],
  );
});

test("reporter partitions both projects without skipping tests or changing their status", () => {
  const projects = ["chromium", "chromium-dev"].map((title) => ({
    title,
    suites: Array.from({ length: 12 }, (_, index) => ({
      title: `spec-${index}`,
      allTests: () => Array.from({ length: 4 }),
    })),
  }));
  const suite = { suites: projects };
  const all = projects.flatMap((project) => project.suites);
  const selected = [];
  const reporter = new BalancedSharding();
  reporter.preprocess({ config: {}, suite });
  for (let current = 1; current <= 4; current++) {
    const excluded = new Set();
    let nativeShardingDisabled = false;
    reporter.preprocess({
      config: { shard: { current, total: 4 } },
      suite,
      testRun: {
        exclude: (file) => excluded.add(file),
        skipSharding: () => {
          nativeShardingDisabled = true;
        },
      },
    });
    assert.equal(nativeShardingDisabled, true);
    const own = all.filter((file) => !excluded.has(file));
    for (const project of projects)
      assert.ok(own.some((file) => project.suites.includes(file)));
    selected.push(...own);
  }
  assert.equal(selected.length, all.length);
  assert.equal(new Set(selected).size, all.length);
});
