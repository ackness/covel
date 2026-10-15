import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function isCheckedFile(file) {
  const parts = file.split("/");
  return (
    ["plugins", "templates"].includes(parts[0]) &&
    !parts.some((part) =>
      ["_archive", "test", "tests", "__tests__", "__snapshots__"].includes(
        part,
      ),
    ) &&
    !/\.(?:test|spec|selfcheck)\.[cm]?[jt]sx?$/.test(file)
  );
}

function randomnessProblems(files) {
  const problems = [];
  for (const [file, text] of files) {
    if (!isCheckedFile(file)) continue;
    // Check identifiers as well as calls so renamed crypto imports cannot
    // introduce an independent random source. Word boundaries allow helpers
    // such as randomInteger that receive the session's random source.
    const forbidden =
      /\bMath\s*(?:(?:\?\.|\.)\s*random\b|\[\s*["']random["']\s*\])|\b(?:randomUUID|randomInt|randomBytes|getRandomValues)\b/g;
    for (const match of text.matchAll(forbidden)) {
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(`${file}:${line}: ${match[0]}`);
    }
  }
  return problems;
}

test("the randomness gate rejects direct sources and renamed imports", () => {
  for (const source of [
    "Math.random()",
    "Math . random()",
    "Math?.random()",
    'Math["random"]()',
    'import { randomUUID as uuid } from "node:crypto";',
    'import { randomInt, randomBytes } from "node:crypto";',
    "crypto.getRandomValues(buffer)",
  ]) {
    for (const file of [
      "plugins/example/handler.js",
      "templates/example/tools/roll.ts",
    ]) {
      assert.ok(
        randomnessProblems([[file, source]]).length > 0,
        `${file}: ${source}`,
      );
    }
  }
  assert.deepEqual(
    randomnessProblems([["plugins/example/handler.js", "\nMath.random()"]]),
    ["plugins/example/handler.js:2: Math.random"],
  );
});

test("the randomness gate permits session randomness and ignores tests and archives", () => {
  assert.deepEqual(
    randomnessProblems([
      [
        "plugins/example/handler.js",
        'ctx.random.int(1, 7); shortId("roll", label, ctx.sessionId, ctx.random); randomInteger(1, 7);',
      ],
      ...[
        "plugins/_archive/example/handler.js",
        "plugins/example/tests/helper.js",
        "plugins/example/test/helper.js",
        "plugins/example/__tests__/helper.ts",
        "plugins/example/handler.test.js",
        "plugins/example/handler.spec.ts",
        "templates/example/tests/helper.js",
        "templates/example/handler.test.mjs",
        "packages/example/src/random.ts",
      ].map((file) => [file, "Math.random()"]),
    ]),
    [],
  );
});

test("plugins and templates use only the injected random source", () => {
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "plugins",
      "templates",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(
      (file) =>
        file && isCheckedFile(file) && existsSync(path.join(root, file)),
    );
  assert.ok(
    files.length > 0,
    "the source scan must find plugins and templates",
  );
  assert.deepEqual(
    randomnessProblems(
      files.map((file) => [file, readFileSync(path.join(root, file), "utf8")]),
    ),
    [],
    "Use ctx.random (and shortId's fourth argument); use the SDK's makeProposal for proposal envelopes",
  );
});
