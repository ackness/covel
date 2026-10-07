import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { compileStagedServer } from "./compile-server.mjs";

test("precompiled workspace exports preserve package assets and run without TypeScript", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "covel-compiled-server-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dependency = path.join(root, "node_modules/@covel/fixture");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(dependency, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  const exports = {
    ".": { types: "./src/index.ts", import: "./src/index.ts" },
    "./sub": "./src/sub.ts",
  };
  await fs.writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({ type: "module", exports }),
  );
  await fs.writeFile(
    path.join(dependency, "asset.json"),
    '{"label":"preserved"}',
  );
  await fs.writeFile(
    path.join(dependency, "src/index.ts"),
    'import { readFileSync } from "node:fs"; import { sub } from "./sub.js"; export const value: string = JSON.parse(readFileSync(new URL("../asset.json", import.meta.url), "utf8")).label + sub;',
  );
  await fs.writeFile(
    path.join(dependency, "src/sub.ts"),
    'export const sub: string = "-sub";',
  );
  await fs.writeFile(
    path.join(root, "src/index.ts"),
    'import { value } from "@covel/fixture"; import { sub } from "@covel/fixture/sub"; console.log(value + sub);',
  );
  assert.equal(await compileStagedServer(root), 3);
  const manifest = JSON.parse(
    await fs.readFile(path.join(dependency, "package.json"), "utf8"),
  );
  assert.equal(manifest.exports["."].types, "./src/index.ts");
  assert.equal(manifest.exports["."].import, "./src/index.js");
  assert.equal(manifest.exports["./sub"], "./src/sub.js");
  // Remove source to prove plain Node can load the complete compiled graph.
  for (const filename of [
    "src/index.ts",
    "node_modules/@covel/fixture/src/index.ts",
    "node_modules/@covel/fixture/src/sub.ts",
  ])
    await fs.rm(path.join(root, filename));
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src/index.js")],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "preserved-sub-sub");
});
