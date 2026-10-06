import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ensurePluginSdkBuild,
  pluginSdkStaleReason,
} from "../lib/plugin-sdk-build.mjs";

const SOURCES_WRITTEN = new Date("2026-01-01T00:00:00Z");
const BUILT = new Date("2026-01-01T00:01:00Z");
const AFTER_BUILD = new Date("2026-01-01T00:02:00Z");
const NOW = new Date("2026-01-02T00:00:00Z").getTime();

/** A package directory with its sources written first and its build after. */
function fixture(t, { built = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "covel-plugin-sdk-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (file, time) => {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "");
    utimesSync(target, time, time);
  };
  for (const file of [
    "package.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "src/index.ts",
    "src/nested/tool.ts",
  ])
    write(file, SOURCES_WRITTEN);
  if (built) write("dist/index.js", BUILT);
  return { dir, write };
}

const calls = (dir, build) => {
  let count = 0;
  const built = ensurePluginSdkBuild({
    dir,
    log: () => {},
    build: () => {
      count += 1;
      build?.();
    },
  });
  return { built, count };
};

test("a build written after every input is current and is not made again", (t) => {
  const { dir } = fixture(t);
  assert.equal(pluginSdkStaleReason(dir, NOW), undefined);
  assert.deepEqual(calls(dir), { built: false, count: 0 });
});

test("an input written after the build makes it stale", (t) => {
  const { dir, write } = fixture(t);
  write("src/nested/tool.ts", AFTER_BUILD);
  assert.equal(
    pluginSdkStaleReason(dir, NOW),
    `${path.join("src", "nested", "tool.ts")} is newer than the build`,
  );

  const config = fixture(t);
  config.write("tsconfig.build.json", AFTER_BUILD);
  assert.equal(
    pluginSdkStaleReason(config.dir, NOW),
    "tsconfig.build.json is newer than the build",
  );
});

test("a stale build is made once, and the process goes on with what it wrote", (t) => {
  const { dir, write } = fixture(t);
  write("src/index.ts", AFTER_BUILD);
  const result = calls(dir, () => write("dist/index.js", new Date(NOW)));
  assert.deepEqual(result, { built: true, count: 1 });
  assert.equal(pluginSdkStaleReason(dir, NOW), undefined);
});

test("a missing build is made", (t) => {
  const { dir, write } = fixture(t, { built: false });
  assert.equal(
    pluginSdkStaleReason(dir, NOW),
    `${path.join("dist", "index.js")} is missing`,
  );
  const result = calls(dir, () => write("dist/index.js", BUILT));
  assert.deepEqual(result, { built: true, count: 1 });
});

test("a build that writes nothing stops the process", (t) => {
  const stale = fixture(t);
  stale.write("src/index.ts", AFTER_BUILD);
  assert.throws(() => calls(stale.dir), /wrote no output/);

  const missing = fixture(t, { built: false });
  assert.throws(() => calls(missing.dir), /wrote no output/);
});

test("a source dated in the future does not start a build at every start", (t) => {
  const { dir, write } = fixture(t);
  write("src/index.ts", new Date(NOW + 60_000));
  assert.equal(pluginSdkStaleReason(dir, NOW), undefined);
});

test("the server's dev scripts run the check at every start of the process", () => {
  const { scripts } = JSON.parse(
    readFileSync(
      new URL("../../apps/server/package.json", import.meta.url),
      "utf8",
    ),
  );
  for (const name of ["dev", "dev:pg"])
    assert.match(
      scripts[name],
      /tsx watch .*--import=\.\.\/\.\.\/scripts\/ensure-plugin-sdk\.mjs /,
      name,
    );
});
