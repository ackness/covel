import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crossSpawn from "cross-spawn";

const root = fileURLToPath(new URL("../", import.meta.url));

export function verifyShardCoverage(full, shards) {
  const expected = new Set(full);
  const combined = shards.flat();
  assert.ok(expected.size > 0, "The full browser collection is empty");
  assert.equal(expected.size, full.length, "Duplicate IDs in full collection");
  assert.equal(
    new Set(combined).size,
    combined.length,
    "Overlapping browser shards",
  );
  assert.deepEqual(
    new Set(combined),
    expected,
    "Shards must cover exactly the full collection",
  );
}

function collect(args = []) {
  const result = crossSpawn.sync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      ...args,
      "--list",
      "--reporter=./scripts/e2e-sharding.mjs,json",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Browser collection failed: ${result.stderr}\n${result.stdout}`,
    );
  const report = JSON.parse(result.stdout);
  const specs = [];
  function visit(suite) {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  }
  visit(report);
  return {
    ids: specs.flatMap((spec) =>
      spec.tests.map((test) => `${test.projectName}:${spec.id}`),
    ),
    files: new Set(specs.map((spec) => basename(spec.file))),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const full = collect();
  const shards = [];
  for (let index = 1; index <= 8; index++) {
    const shard = collect([`--shard=${index}/8`]);
    shards.push(shard.ids);
    console.log(`Browser shard ${index}/8: ${shard.ids.length} tests`);
  }
  verifyShardCoverage(full.ids, shards);
  const extensions = collect([
    "--config=tests/e2e/third-party-stage.config.ts",
  ]);
  const files = readdirSync(new URL("../tests/e2e/", import.meta.url)).filter(
    (file) => file.endsWith(".acceptance.ts"),
  );
  assert.ok(files.length > 0, "No extension acceptance files found");
  assert.deepEqual(
    extensions.files,
    new Set(files),
    "Every extension acceptance file must be collected",
  );
  console.log(
    `Exact disjoint union: ${full.ids.length} test/project IDs; ${files.length} extension files collected.`,
  );
}
