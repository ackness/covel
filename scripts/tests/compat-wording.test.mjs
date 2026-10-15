import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const wording =
  /\b(?:legacy|compat(?:ible|ibility)?|backwards?|old[\t ]+(?:format|decoder))\b/i;

// These are current domain/API vocabulary, not old Covel data formats.
// Keep exceptions file-specific so new source files must justify their wording.
const allowlist = new Map([
  [
    "apps/web/src/components/session/stage/stage-selectors.ts",
    "Current message blocks may omit turnId; the stage selector intentionally handles them.",
  ],
  [
    "apps/web/src/services/api/llm.ts",
    "The reasoning profile exposes the provider family named compatible.",
  ],
  [
    "apps/web/src/theme-system/theme-css-derive.ts",
    "backwards is a standard CSS animation-fill-mode value.",
  ],
  [
    "packages/ai-provider/src/capability/reasoning-models.ts",
    "compatible names the generic OpenAI API provider family.",
  ],
  [
    "packages/ai-provider/src/reasoning-effort.ts",
    "Reasoning defaults select the provider family named compatible.",
  ],
  [
    "packages/ai-provider/src/gateway.ts",
    "compatibility is an AI SDK warning category.",
  ],
  [
    "packages/ai-provider/src/adapters/response-diagnostics.ts",
    "Reads the AI SDK compatibility warning category.",
  ],
  [
    "packages/runtime/src/function-runtime/gateway-trace.ts",
    "Preserves the AI SDK compatibility warning category in traces.",
  ],
  [
    "packages/shared/src/types/llm-diagnostics.ts",
    "Types the AI SDK compatibility warning category.",
  ],
  [
    "packages/shared/src/utils/provider-defaults.ts",
    "DashScope's external API URL contains compatible-mode.",
  ],
  [
    "packages/shared/src/env/groups/ai.ts",
    "Describes the OpenAI-compatible provider API, not a Covel format.",
  ],
  [
    "packages/runtime/src/schedule/accepts-compat.ts",
    "Checks producer/consumer schema compatibility within the current contract.",
  ],
  [
    "packages/runtime/src/schedule/input-bindings.ts",
    "Consumes the current producer/consumer schema compatibility check.",
  ],
  [
    "plugins/world-time/schema.js",
    "backward is a supported world-clock direction.",
  ],
  ["plugins/world-time/clock.js", "Computes backward movement of world time."],
  [
    "plugins/world-time/tools/advance-world-time.js",
    "Exposes the backward world-clock direction to plugins.",
  ],
]);

function isSource(file) {
  return (
    /^(?:(?:apps|packages)\/[^/]+\/src\/|plugins\/[^/]+\/)/.test(file) &&
    /\.(?:[cm]?[jt]sx?|css)$/.test(file) &&
    !/(?:^|\/)(?:tests?|__tests__|__mocks__|fixtures|_archive|node_modules|dist)(?:\/|$)/.test(
      file,
    ) &&
    !/\.(?:test|spec)\.[^/]+$/.test(file) &&
    // Store contract files are shared test suites, even though they live in src.
    !file.startsWith("packages/store/src/contract/")
  );
}

function violations(file, source, exceptions = allowlist) {
  if (!isSource(file) || exceptions.has(file)) return [];
  const lines = source.split(/\r?\n/);
  return lines.flatMap((line, index) =>
    wording.test(line) &&
    !/\bponytail:/.test(line) &&
    !/\bponytail:/.test(lines[index - 1] ?? "")
      ? [`${file}:${index + 1}: ${line.trim()}`]
      : [],
  );
}

test("wording gate matches words, phrases and case without matching unrelated identifiers", () => {
  const file = "apps/example/src/reader.ts";
  for (const term of [
    "LEGACY",
    "compat",
    "compatibility",
    "OpenAI-compatible",
    "backward",
    "backwards",
    "old format",
    "old decoder",
  ]) {
    assert.equal(violations(file, `// ${term} reader`).length, 1, term);
  }
  assert.deepEqual(
    violations(file, "const compacted = compatibilityCheck();"),
    [],
  );
});

test("only a same-line or preceding-line ponytail marker or a reasoned file exception permits wording", () => {
  const file = "packages/example/src/reader.ts";
  assert.deepEqual(violations(file, "// ponytail: legacy reader"), []);
  assert.deepEqual(
    violations(file, "// ponytail: retained limit\n// legacy reader"),
    [],
  );
  assert.equal(
    violations(file, "// ponytail: retained limit\n\n// legacy reader").length,
    1,
  );
  assert.equal(
    violations(file, "// legacy reader\n// ponytail: misplaced").length,
    1,
  );
  assert.deepEqual(
    violations(file, "// legacy reader", new Map([[file, "Reviewed reason"]])),
    [],
  );
});

test("source coverage includes plugins and untracked code but excludes tests and archives", () => {
  for (const file of [
    "apps/example/src/view.tsx",
    "packages/example/src/index.ts",
    "plugins/example/server/index.js",
    "plugins/example/ui.css",
  ]) {
    assert.equal(isSource(file), true, file);
  }
  for (const file of [
    "apps/example/tests/view.ts",
    "packages/example/src/view.test.ts",
    "packages/example/src/view.spec.js",
    "packages/example/src/__tests__/fixture.ts",
    "packages/store/src/contract/suites/core-suites.ts",
    "plugins/example/tests/helper.js",
    "plugins/_archive/example/index.js",
    "plugins/example/node_modules/module/index.js",
    "plugins/example/PLUGIN.md",
  ]) {
    assert.equal(isSource(file), false, file);
  }
});

test("non-test source explains compatibility wording", () => {
  const files = [
    ...new Set(
      execFileSync(
        "git",
        [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          "apps",
          "packages",
          "plugins",
        ],
        { cwd: root, encoding: "utf8" },
      ).split("\0"),
    ),
  ].filter((file) => isSource(file) && existsSync(path.join(root, file)));
  assert.ok(files.length > 0, "the source scan must not be empty");
  for (const [file, reason] of allowlist) {
    assert.ok(reason.trim(), `${file}: the exception needs a reason`);
    assert.ok(files.includes(file), `${file}: remove the obsolete exception`);
    assert.match(
      readFileSync(path.join(root, file), "utf8"),
      wording,
      `${file}: remove the unused exception`,
    );
  }
  assert.deepEqual(
    files.flatMap((file) =>
      violations(file, readFileSync(path.join(root, file), "utf8")),
    ),
    [],
    "Remove obsolete branches, describe current behavior plainly, or explain the limit with ponytail: and update both technical-debt ledgers. Use a reasoned file exception only for intentional vocabulary.",
  );
});
