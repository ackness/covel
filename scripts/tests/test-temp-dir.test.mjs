import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const baseConfigUrl = new URL("../../vitest.base.ts", import.meta.url);

function vitestPackages() {
  const directories = ["apps", "packages", "plugins", "templates"].flatMap(
    (group) =>
      fs
        .readdirSync(path.join(repoRoot, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(group, entry.name)),
  );
  return directories.filter((directory) => {
    const manifest = path.join(repoRoot, directory, "package.json");
    if (!fs.existsSync(manifest)) return false;
    const { scripts } = JSON.parse(fs.readFileSync(manifest, "utf8"));
    return /\bvitest\b/.test(scripts?.test ?? "");
  });
}

test("every package that runs Vitest gives the run a temp directory of its own", () => {
  const packages = vitestPackages();
  assert.ok(packages.length > 30, `found only ${packages.length} packages`);
  // Loading vitest.base.ts is what creates the directory, so a config that
  // does not import it leaves the run in the shared temp directory.
  const missing = packages.filter((directory) => {
    const config = path.join(repoRoot, directory, "vitest.config.ts");
    return (
      !fs.existsSync(config) ||
      !/vitest\.base\.(js|ts)"/.test(fs.readFileSync(config, "utf8"))
    );
  });
  assert.deepEqual(missing, []);
});

test("a run's temp directory is removed at exit, and so is one a killed run left", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "covel-temp-dir-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // A process that has exited: its ID belongs to no running process.
  const gone = spawnSync(process.execPath, ["--eval", ""]).pid;
  const abandoned = path.join(base, `covel-test-${gone}-killed`);
  const inUse = path.join(base, `covel-test-${process.pid}-running`);
  const unrelated = path.join(base, "something-else");
  for (const directory of [abandoned, inUse, unrelated])
    fs.mkdirSync(path.join(directory, "nested"), { recursive: true });

  const env = { ...process.env, TMPDIR: base, TMP: base, TEMP: base };
  delete env.COVEL_TEST_TEMP_DIR;
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(baseConfigUrl.href)});
       const { tmpdir } = await import("node:os");
       const { writeFileSync, mkdtempSync } = await import("node:fs");
       const { join } = await import("node:path");
       writeFileSync(join(mkdtempSync(join(tmpdir(), "leak-")), "file"), "x");
       console.log(tmpdir());`,
    ],
    { cwd: repoRoot, env, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const runDirectory = run.stdout.trim();

  assert.equal(path.dirname(runDirectory), base);
  assert.match(path.basename(runDirectory), /^covel-test-\d+-/);
  assert.equal(fs.existsSync(runDirectory), false);
  assert.equal(fs.existsSync(abandoned), false);
  assert.equal(fs.existsSync(inUse), true);
  assert.equal(fs.existsSync(unrelated), true);
});
