import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyShardCoverage } from "../check-e2e-shards.mjs";

test("browser collection rejects omissions, overlap, unexpected tests and empty suites", () => {
  const all = ["chromium:a", "chromium-dev:b", "chromium:c"];
  assert.doesNotThrow(() =>
    verifyShardCoverage(all, [[all[0]], [all[1]], [all[2]], []]),
  );
  for (const shards of [
    [[all[0]], [all[1]]],
    [[...all], [all[0]]],
    [[...all], ["unknown:d"]],
  ])
    assert.throws(() => verifyShardCoverage(all, shards));
  assert.throws(() => verifyShardCoverage([], [[], [], [], []]));
  assert.throws(() => verifyShardCoverage([...all, all[0]], [[...all]]));
});
