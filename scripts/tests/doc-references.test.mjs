// Documentation references that must match the code: a world file named
// with a bare language, and store methods named in the transaction reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function filesUnder(directory, extension) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full, extension));
    else if (name.endsWith(extension)) found.push(full);
  }
  return found;
}

test("world files in docs code blocks name the locale exactly, not a bare language", () => {
  // The loader ignores a world file named with a bare language, so a code
  // block that shows one teaches the wrong name.
  // Only real language codes count: `world.ir.yaml` is a file name, not a locale.
  const bare =
    /\b(WORLD|world)\.(en|zh|ja|ko|ru|fr|de|es|pt|it|ar|th|vi|tr|nl|pl|uk|hi)\.(md|ya?ml|json)\b/;
  const problems = [];
  for (const file of filesUnder(path.join(root, "docs"), ".md")) {
    const text = readFileSync(file, "utf8");
    for (const block of text.match(/```[\s\S]*?```/g) ?? []) {
      for (const line of block.split("\n")) {
        if (bare.test(line)) problems.push(`${path.relative(root, file)}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("store methods named in transactions.md exist in the store package", () => {
  // A method is declared as a function, a const, or a class member.
  const declaration = /(?:function\s+|^\s*(?:async\s+)?|const\s+)((?:list|get)[A-Z]\w*)\s*[(<:=]/gm;
  const declared = new Set();
  for (const file of filesUnder(path.join(root, "packages/store/src"), ".ts")) {
    if (file.endsWith(".test.ts")) continue;
    for (const match of readFileSync(file, "utf8").matchAll(declaration)) {
      declared.add(match[1]);
    }
  }
  const problems = [];
  for (const page of [
    "docs/reference/transactions.md",
    "docs/en/reference/transactions.md",
  ]) {
    const text = readFileSync(path.join(root, page), "utf8");
    for (const match of text.matchAll(/`((?:list|get)[A-Z]\w*)\(/g)) {
      if (!declared.has(match[1])) problems.push(`${page}: \`${match[1]}(\` is not a store method`);
    }
  }
  assert.deepEqual(problems, []);
});
