import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { matcher, selectTests } from "../lib/push-scope.mjs";
import { isDocsOnly } from "../lib/change-scope.mjs";

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
    "@covel/site",
  ]);
  assert.deepEqual(select("scripts/create-plugin.js").filters, [
    "@covel/test-runtime",
  ]);
  assert.deepEqual(select("tests/third-party/probe/PLUGIN.md").filters, [
    "@covel/server",
    "@covel/test-runtime",
  ]);
  // Listed once when the package itself changed too. The affinity plugin's
  // suite loads server source, so it is selected alongside the server.
  assert.deepEqual(
    select("apps/server/src/index.ts", "worlds/mistport/world.yaml").filters,
    ["...@covel/server", "@covel/plugin-affinity", "@covel/site"],
  );
  assert.deepEqual(select("packs/builtin.yaml").filters, [
    "@covel/server",
    "@covel/site",
  ]);
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
  assert.deepEqual(select("docs/plugins/essentials.md"), {
    full: false,
    filters: ["@covel/plugin-loader"],
    docs: true,
  });
});

test("browser controls need local static and collection checks, and full source CI", () => {
  for (const file of [
    ".github/workflows/ci.yml",
    ".github/workflows/gate.yml",
    "playwright.config.ts",
    "tests/e2e/third-party-stage.config.ts",
    "tests/e2e/sandbox-surfaces.acceptance.ts",
    "scripts/e2e-cpu-list.mjs",
  ]) {
    assert.deepEqual(
      select(file),
      { full: false, filters: [], docs: false },
      file,
    );
    assert.equal(isDocsOnly([file]), false, file);
  }
});

test("matcher handles unclosed braces literally without hanging and expands wildcards inside braces", () => {
  const unclosed = matcher(["src/{foo", "src/{a,{b}"]);
  assert.equal(unclosed("src/{foo"), true);
  assert.equal(unclosed("src/foo"), false);
  assert.equal(unclosed("src/{a,b"), true);

  const wildcardsInBraces = matcher([
    "plugins/*/{*.json,runtimes/*/ui/*.json}",
    "docs/{*.md,en/**/*.md}",
    "nested/{a,{b,c}}.ts",
  ]);
  assert.equal(wildcardsInBraces("plugins/demo/panel.json"), true);
  assert.equal(
    wildcardsInBraces("plugins/demo/runtimes/r1/ui/panel.json"),
    true,
  );
  assert.equal(wildcardsInBraces("plugins/demo/sub/panel.json"), false);
  assert.equal(wildcardsInBraces("docs/README.md"), true);
  assert.equal(wildcardsInBraces("docs/en/guide.md"), true);
  assert.equal(wildcardsInBraces("docs/en/sub/guide.md"), true);
  assert.equal(wildcardsInBraces("docs/zh/guide.md"), false);
  assert.equal(wildcardsInBraces("nested/a.ts"), true);
  assert.equal(wildcardsInBraces("nested/b.ts"), true);
  assert.equal(wildcardsInBraces("nested/c.ts"), true);
  assert.equal(wildcardsInBraces("nested/d.ts"), false);
});

test("negated $TURBO_ROOT$ inputs exclude matching files without negating workspace files", () => {
  const customPackages = [
    { dir: "packages/reader", name: "@covel/reader" },
    { dir: "packages/other", name: "@covel/other" },
  ];
  const customTurbo = {
    globalDependencies: ["tsconfig.json"],
    tasks: {
      test: {
        inputs: [
          "$TURBO_DEFAULT$",
          "$TURBO_ROOT$/shared/**",
          "!$TURBO_ROOT$/shared/ignored.txt",
          "!$TURBO_ROOT$/package.json",
        ],
      },
      "@covel/reader#test": {
        inputs: [
          "$TURBO_DEFAULT$",
          "$TURBO_ROOT$/assets/**",
          "!$TURBO_ROOT$/assets/drafts/**",
        ],
      },
      "@covel/other#test": {
        inputs: ["$TURBO_DEFAULT$", "!$TURBO_ROOT$/assets/**"],
      },
    },
  };

  assert.deepEqual(
    selectTests({
      files: ["assets/live/data.json"],
      packages: customPackages,
      turbo: customTurbo,
    }),
    { full: false, filters: ["@covel/reader"], docs: false },
  );

  // Negated by @covel/reader#test: no package claims assets/drafts/wip.json,
  // so selectTests falls back to full rather than falsely selecting @covel/reader.
  const excludedAsset = selectTests({
    files: ["assets/drafts/wip.json"],
    packages: customPackages,
    turbo: customTurbo,
  });
  assert.equal(excludedAsset.full, true);
  assert.match(excludedAsset.reason, /outside every package/);

  // Negated inside a covered-without-tests path (scripts/**) selects no suite.
  const excludedInCovered = selectTests({
    files: ["scripts/ignored.mjs"],
    packages: customPackages,
    turbo: {
      tasks: {
        test: { inputs: ["$TURBO_DEFAULT$"] },
        "@covel/reader#test": {
          inputs: [
            "$TURBO_DEFAULT$",
            "$TURBO_ROOT$/scripts/**",
            "!$TURBO_ROOT$/scripts/ignored.mjs",
          ],
        },
      },
    },
  });
  assert.deepEqual(excludedInCovered, {
    full: false,
    filters: [],
    docs: false,
  });

  // Base test task root inputs respect their own exclusions, while WORKSPACE_FILES
  // cannot be negated by a task input.
  assert.equal(
    selectTests({
      files: ["shared/active.txt"],
      packages: customPackages,
      turbo: customTurbo,
    }).reason,
    "shared/active.txt configures every package",
  );
  assert.match(
    selectTests({
      files: ["shared/ignored.txt"],
      packages: customPackages,
      turbo: customTurbo,
    }).reason,
    /outside every package/,
  );
  assert.equal(
    selectTests({
      files: ["package.json"],
      packages: customPackages,
      turbo: customTurbo,
    }).reason,
    "package.json configures every package",
  );
});
