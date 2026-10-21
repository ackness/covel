import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDocsOnly, isDocsPath } from "../lib/change-scope.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("documentation is what people and agents read, wherever it lives", () => {
  for (const file of [
    "docs/README.md",
    // A changelog fragment alone takes the short path; a source change
    // always comes with other files.
    "docs/changelog.d/trace-retention.md",
    "docs/reference/schema/plugin-manifest.md",
    "docs/guide/assets/diagram.png",
    "README.md",
    "README.zh-CN.md",
    "AGENTS.md",
    "docs/AGENTS.md",
    "packages/store/CLAUDE.md",
    "plugins/narrator/README.md",
    "worlds/mistport/README.zh-CN.md",
    "templates/plugin-multi-runtime/README.md",
    ".claude/skills/create-world/SKILL.md",
    ".claude/skills/create-world/references/dimensions.md",
    ".assets/images/demo.gif",
    "LICENSE",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ])
    assert.equal(isDocsPath(file), true, file);
});

test("Markdown that a loader reads is source, and so is everything else", () => {
  for (const file of [
    "PLUGIN.md",
    "RUNTIME.md",
    "WORLD.en.md",
    "prompts/server/README.md",
    "plugins/narrator/PLUGIN.md",
    "plugins/narrator/PLUGIN.zh.md",
    "plugins/narrator/runtimes/story/RUNTIME.md",
    "prompts/server/turn.md",
    "worlds/mistport/WORLD.md",
    "worlds/mistport/WORLD.en.md",
    "templates/plugin-multi-runtime/PLUGIN.md",
    "packages/shared/src/index.ts",
    "packages/shared/README.ts",
    ".claude/settings.json",
    ".github/workflows/ci.yml",
    ".env.example",
    "package.json",
    "docs.ts",
    "LICENSE.txt",
  ])
    assert.equal(isDocsPath(file), false, file);
});

test("a change is documentation only when it has files and all of them are documentation", () => {
  assert.equal(isDocsOnly(["docs/a.md", "plugins/a/README.md"]), true);
  assert.equal(isDocsOnly(["docs/a.md", "plugins/a/PLUGIN.md"]), false);
  // No changed file is no evidence of anything.
  assert.equal(isDocsOnly([]), false);
});

test("the docs package command runs every package test that reads documentation", () => {
  // A call that builds or opens docs, an agent skill, or a reader-facing
  // README/agent instruction file (also documentation-only in CI).
  const readsDocs =
    /(?:resolve|join|new URL|readFile(?:Sync)?|readdir(?:Sync)?)\([^)]*["'`][^"'`\n]*(?:\bdocs\/|\.claude\/skills|\bREADME(?:\.[\w-]+)?\.md|\b(?:AGENTS|CLAUDE)\.md)/;
  const isTest = /\.(?:test|spec|selfcheck)\.[cm]?[jt]sx?$/;
  const reading = [];
  for (const group of ["apps", "packages", "plugins"]) {
    for (const entry of fs.readdirSync(path.join(repoRoot, group))) {
      const directory = path.join(repoRoot, group, entry);
      const manifest = path.join(directory, "package.json");
      if (!fs.existsSync(manifest)) continue;
      const { name } = JSON.parse(fs.readFileSync(manifest, "utf8"));
      for (const file of fs.readdirSync(directory, { recursive: true })) {
        if (!isTest.test(file) || file.includes("node_modules")) continue;
        if (readsDocs.test(fs.readFileSync(path.join(directory, file), "utf8")))
          reading.push(`${name} ${file.split(path.sep).join("/")}`);
      }
    }
  }

  const { scripts } = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const run = [
    ...scripts["test:docs:packages"].matchAll(/--filter (\S+) exec vitest run (\S+)/g),
  ].map(([, name, file]) => `${name} ${file}`);

  // A test missing from the script is skipped when only documentation
  // changes: add it to `test:docs:packages` in the root package.json.
  assert.deepEqual(run.sort(), reading.sort());
});
