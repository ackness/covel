import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readPlainYamlFrontmatter } from "../../packages/plugin-loader/src/plain-yaml-frontmatter.ts";

test("an empty translated header leaves later Markdown rules in the body", () => {
  const body = "Translated prompt\n\n---\nSecond section\n";
  assert.deepEqual(readPlainYamlFrontmatter(`---\n---\n${body}`), {
    data: {},
    body,
  });
});

test("only the shared guarded reader imports gray-matter", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const imports = [];
  for (const directory of [
    "packages/plugin-loader/src",
    "packages/plugin-loader/scripts",
    "scripts",
  ]) {
    for (const file of await readdir(path.join(root, directory), {
      recursive: true,
    })) {
      if (!/\.[cm]?[jt]s$/.test(file)) continue;
      const source = await readFile(path.join(root, directory, file), "utf8");
      if (/from ["']gray-matter["']/.test(source))
        imports.push(`${directory}/${file}`);
    }
  }
  assert.deepEqual(imports, [
    "packages/plugin-loader/src/plain-yaml-frontmatter.ts",
  ]);
});
