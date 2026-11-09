import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  currentBarrel,
  exportedNames,
  sharedBarrel,
  sharedBarrelErrors,
  writeBaseline,
} from "../lib/barrel-exports.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "covel-barrel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  write(
    sharedBarrel.manifest,
    JSON.stringify({ exports: { ".": "./src/index.ts", "./world": "./x.ts" } }),
  );
  write(
    "packages/shared/src/index.ts",
    [
      'export * from "./a.js";',
      'export * from "./dir/index.js";',
      'export { renamed as publicName, type Kind } from "./b.js";',
      'export * as ns from "./c.js";',
      'export * from "@scope/pkg";',
      "export const { one, two: [three] } = tuple;",
      "export default 1;",
    ].join("\n"),
  );
  write(
    "packages/shared/src/a.ts",
    "export function fnA() {}\nexport interface IfaceA {}\nexport enum E {}\n" +
      'export * from "./a2.js";\nconst hidden = 1;\n',
  );
  write("packages/shared/src/a2.ts", "export class FromA2 {}");
  write("packages/shared/src/dir/index.ts", "export type DirType = 1;");
  const accept = () => writeBaseline(root, currentBarrel(root));
  return { root, write, accept };
}

test("export names are read from syntax, expanding relative export-star", (t) => {
  const { root } = fixture(t);
  assert.deepEqual(currentBarrel(root), [
    "* from @scope/pkg",
    "DirType",
    "E",
    "FromA2",
    "IfaceA",
    "Kind",
    "fnA",
    "ns",
    "one",
    "publicName",
    "three",
  ]);
});

test("an unchanged barrel passes", (t) => {
  const { root, accept } = fixture(t);
  accept();
  assert.deepEqual(sharedBarrelErrors(root), []);
});

test("a new export fails and points to the subpath entries", (t) => {
  const { root, write, accept } = fixture(t);
  accept();
  write(
    "packages/shared/src/index.ts",
    'export * from "./a.js";\nexport { fresh } from "./b.js";\n',
  );
  const errors = sharedBarrelErrors(root);
  assert.equal(errors.length > 0, true);
  assert.match(errors[0], /frozen/);
  assert.match(errors[0], /fresh/);
  assert.match(errors[0], /\.\/world/);
});

test("a name added to a module the barrel re-exports with export-star fails", (t) => {
  const { root, write, accept } = fixture(t);
  accept();
  write(
    "packages/shared/src/a2.ts",
    "export class FromA2 {}\nexport const sneaky = 1;",
  );
  assert.match(sharedBarrelErrors(root).join("\n"), /sneaky/);
});

test("a removed export fails until the baseline shrinks", (t) => {
  const { root, write, accept } = fixture(t);
  accept();
  write("packages/shared/src/a2.ts", "export {};");
  const [error] = sharedBarrelErrors(root);
  assert.match(error, /left the root entry/);
  assert.match(error, /shared-barrel-baseline\.mjs --update/);
});

test("the update command shrinks the baseline but never records an addition", (t) => {
  const { root, write, accept } = fixture(t);
  accept();
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [
        path.join(repo, "scripts/shared-barrel-baseline.mjs"),
        "--root",
        root,
        ...args,
      ],
      { encoding: "utf8" },
    );
  write("packages/shared/src/a2.ts", "export {};");
  assert.equal(run().status, 1);
  assert.equal(run("--update").status, 0);
  assert.equal(run().status, 0);
  write("packages/shared/src/a2.ts", "export const more = 1;");
  const grown = run("--update");
  assert.equal(grown.status, 1);
  assert.match(grown.stderr, /frozen/);
  assert.equal(run().status, 1);
});

test("an unresolvable relative re-export is an error, not a silent skip", (t) => {
  const { root, write } = fixture(t);
  write("packages/shared/src/index.ts", 'export * from "./missing.js";');
  assert.throws(() => currentBarrel(root), /cannot resolve/);
});

test("the committed baseline matches the real shared root entry", () => {
  assert.deepEqual(sharedBarrelErrors(repo), []);
  assert.equal(
    exportedNames(path.join(repo, sharedBarrel.entry)).has(
      "fillNarrativeTemplate",
    ),
    true,
  );
});
