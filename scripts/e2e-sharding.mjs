// Playwright's default count-based partition puts the slower development
// project on the final shard. Keep each file (and its serial suites/hooks)
// together, and spread both projects over the same four runners.
import { readFileSync } from "node:fs";

const durations = JSON.parse(
  readFileSync(
    new URL("../tests/e2e/shard-durations.json", import.meta.url),
    "utf8",
  ),
);

export function fileWeight(key, count) {
  const measured = durations[key];
  // Scale when cases are added to an existing file. Unknown files still run;
  // their default is based on the measured project-level cost per test.
  return (
    count *
    (measured
      ? measured.seconds / measured.tests
      : key.startsWith("chromium-dev/")
        ? 9
        : 3)
  );
}

export function shardFiles(files, total) {
  const shards = Array.from({ length: total }, () => ({
    weight: 0,
    files: [],
  }));
  const ordered = [...files].sort(
    (a, b) => b.weight - a.weight || a.key.localeCompare(b.key, "en"),
  );
  for (const file of ordered) {
    const lightest = shards.reduce((a, b) => (a.weight <= b.weight ? a : b));
    lightest.files.push(file);
    lightest.weight += file.weight;
  }
  return shards;
}

export default class BalancedSharding {
  preprocess({ config, suite, testRun }) {
    if (!config.shard) return;
    const files = suite.suites.flatMap((project) =>
      project.suites.map((file) => ({
        key: `${project.title}/${file.title}`,
        weight: fileWeight(
          `${project.title}/${file.title}`,
          file.allTests().length,
        ),
        suite: file,
      })),
    );
    const shards = shardFiles(files, config.shard.total);
    const selected = new Set(shards[config.shard.current - 1].files);
    testRun.skipSharding();
    for (const file of files) {
      if (!selected.has(file)) testRun.exclude(file.suite);
    }
  }
}
