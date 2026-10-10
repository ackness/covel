import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { selectTests } from "../lib/push-scope.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// The repository's own turbo.json and packages: the rules must hold for the
// inputs it really declares.
const turbo = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "turbo.json"), "utf8"),
);
const packages = ["apps", "packages", "plugins"].flatMap((group) =>
  fs.readdirSync(path.join(repoRoot, group)).flatMap((entry) => {
    const manifest = path.join(repoRoot, group, entry, "package.json");
    if (!fs.existsSync(manifest)) return [];
    const { name } = JSON.parse(fs.readFileSync(manifest, "utf8"));
    return [{ dir: `${group}/${entry}`, name }];
  }),
);

function select(...files) {
  return selectTests({ files, packages, turbo });
}

test("a file in a package selects the package with its dependents", () => {
  assert.deepEqual(select("apps/web/src/main.tsx"), {
    full: false,
    filters: ["...@covel/web"],
    docs: false,
  });
  assert.deepEqual(
    select("packages/shared/src/index.ts", "packages/store/src/index.ts")
      .filters,
    ["...@covel/shared", "...@covel/store"],
  );
});

test("a file a suite reads from outside its package selects that suite alone", () => {
  // A bundled plugin's handler is an input of the suites that load plugins.
  assert.deepEqual(select("plugins/narrator/server/index.js").filters, [
    "...@covel/plugin-narrator",
    "@covel/plugin-loader",
    "@covel/runtime",
    "@covel/server",
  ]);
  assert.deepEqual(select("prompts/server/turn.md").filters, [
    "@covel/context",
    "@covel/create",
    "@covel/server",
  ]);
  assert.deepEqual(select("worlds/mistport/WORLD.md").filters, [
    "@covel/server",
  ]);
  assert.deepEqual(select("scripts/create-plugin.js").filters, [
    "@covel/test-runtime",
  ]);
  assert.deepEqual(select("tests/third-party/probe/PLUGIN.md").filters, [
    "@covel/server",
    "@covel/test-runtime",
  ]);
  // Listed once when the package itself changed too.
  assert.deepEqual(
    select("apps/server/src/index.ts", "worlds/mistport/world.yaml").filters,
    ["...@covel/server"],
  );
});

test("what every package reads selects every suite", () => {
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    "vitest.base.ts",
    "tsconfig.json",
    "mise.toml",
  ]) {
    const scope = select("apps/web/src/main.tsx", file);
    assert.equal(scope.full, true, file);
    assert.match(scope.reason, new RegExp(file.replace(".", "\\.")));
  }
});

test("a root file that no rule accounts for selects every suite", () => {
  for (const file of [
    "packs/builtin.yaml",
    "docker/Dockerfile",
    ".env.example",
    "new-root-file.ts",
  ]) {
    assert.equal(select(file).full, true, file);
  }
  assert.equal(select().full, true);
  assert.equal(
    selectTests({ files: ["apps/web/a.ts"], packages: [], turbo }).full,
    true,
  );
  assert.equal(
    selectTests({ files: ["apps/web/a.ts"], packages, turbo: {} }).full,
    true,
  );
});

test("files the static gate or the E2E listing covers select no suite", () => {
  assert.deepEqual(
    select(
      "scripts/check-push.mjs",
      "scripts/tests/check-push.test.mjs",
      ".github/workflows/ci.yml",
      "tests/e2e/smoke.spec.ts",
      ".oxlintrc.jsonc",
    ),
    { full: false, filters: [], docs: false },
  );
});

test("documentation asks for the tests that read it, except the changelog", () => {
  assert.deepEqual(
    select("apps/web/src/main.tsx", "docs/changelog.d/a-change.md"),
    { full: false, filters: ["...@covel/web"], docs: false },
  );
  assert.deepEqual(select("apps/web/src/main.tsx", "docs/reference/api.md"), {
    full: false,
    filters: ["...@covel/web"],
    docs: true,
  });
  // A guide page is also an input of the suite that runs its examples.
  assert.deepEqual(select("docs/guide/plugin-authoring.md"), {
    full: false,
    filters: ["@covel/plugin-loader"],
    docs: true,
  });
});
