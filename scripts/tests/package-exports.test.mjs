import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unusedPackageExports } from "../lib/package-exports.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "covel-export-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const workspace = {
    group: "packages",
    directory: path.join(root, "packages/probe"),
    manifest: {
      name: "@covel/probe",
      exports: { ".": "./src/index.ts", "./unused": "./src/unused.ts" },
    },
  };
  write("packages/probe/src/index.ts", 'export const value = "hello";');
  write("packages/probe/tests/self.test.ts", 'import "@covel/probe/unused";');
  write("apps/consumer/src/main.ts", 'import "@covel/probe";');
  return {
    root,
    workspace,
    write,
    check: (allowlist) => unusedPackageExports(root, [workspace], allowlist),
  };
}

test("rejects a seeded unused export even when its own tests import it", (t) => {
  const probe = fixture(t);
  assert.match(
    probe.check().join("\n"),
    /@covel\/probe\/unused: export has no importer outside its package/,
  );
  assert.equal(probe.check().length, 1);
  assert.deepEqual(
    probe.check({ "@covel/probe/unused": "Public author SDK" }),
    [],
  );
  assert.ok(probe.check({ "@covel/probe/unused": " " }).length > 0);
  assert.ok(
    probe
      .check({ "@covel/probe/absent": "Stale exception" })
      .some((error) => error.includes("existing export")),
  );
});

for (const group of [
  "apps",
  "packages",
  "plugins",
  "templates",
  "scripts",
  "tests",
]) {
  test(`counts external ${group} imports, including type-only, re-export and dynamic imports`, (t) => {
    const probe = fixture(t);
    for (const source of [
      'import type { Value } from "@covel/probe/unused";',
      'export { value } from "@covel/probe/unused";',
      'const load = () => import("@covel/probe/unused");',
    ]) {
      probe.write(`${group}/consumer/tests/usage.ts`, source);
      assert.deepEqual(probe.check(), []);
    }
  });
}

test("ignores comments, strings, built files and retired plugins", (t) => {
  const probe = fixture(t);
  probe.write(
    "apps/consumer/src/example.ts",
    '// import "@covel/probe/unused";\nconst example = \'import "@covel/probe/unused"\';',
  );
  for (const directory of [
    "apps/consumer/dist",
    "apps/consumer/node_modules",
  ]) {
    probe.write(`${directory}/index.js`, 'import "@covel/probe/unused";');
  }
  assert.equal(probe.check().length, 1);
});

test("checks root shorthand and wildcard export maps", (t) => {
  const probe = fixture(t);
  probe.workspace.manifest.exports = {
    "./feature/*": { import: "./src/*.ts" },
  };
  assert.equal(probe.check().length, 1);
  probe.write("tests/consumer.ts", 'import "@covel/probe/feature/one";');
  assert.deepEqual(probe.check(), []);
  probe.workspace.manifest.exports = { import: "./src/index.ts" };
  assert.deepEqual(probe.check(), []);
});
