import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  DOCS_PATH_FILTERS,
  isDocsOnly,
  isDocsPath,
} from "../lib/change-scope.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function workflow(name) {
  return parse(
    fs.readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8"),
  );
}

test("documentation is what people and agents read, wherever it lives", () => {
  for (const file of [
    "docs/README.md",
    "docs/reference/schema/plugin-manifest.md",
    "docs/guide/assets/diagram.png",
    "README.md",
    "README.zh-CN.md",
    "AGENTS.md",
    "docs/v2/AGENTS.md",
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

test("the workflows and the pre-push hook agree on what documentation is", () => {
  const ci = workflow("ci.yml").on;
  const docs = workflow("docs.yml").on;
  assert.deepEqual(ci.pull_request["paths-ignore"], DOCS_PATH_FILTERS);
  assert.deepEqual(ci.push["paths-ignore"], DOCS_PATH_FILTERS);
  assert.deepEqual(docs.pull_request.paths, DOCS_PATH_FILTERS);
  assert.deepEqual(docs.push.paths, DOCS_PATH_FILTERS);
  const steps = workflow("docs.yml").jobs.docs.steps.map((step) => step.run);
  assert.ok(steps.includes("pnpm check"));
  assert.ok(steps.includes("pnpm test:docs"));
});

test("pnpm test:docs runs every test that reads documentation", () => {
  // A call that builds or opens a path inside docs/ or the agent skills.
  const readsDocs =
    /(?:resolve|join|new URL|readFile(?:Sync)?|readdir(?:Sync)?)\([^)]*["'`][^"'`\n]*(?:\bdocs\/|\.claude\/skills)/;
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
    ...scripts["test:docs"].matchAll(/--filter (\S+) exec vitest run (\S+)/g),
  ].map(([, name, file]) => `${name} ${file}`);

  // A test missing from the script is skipped when only documentation
  // changes: add it to `test:docs` in the root package.json.
  assert.deepEqual(run.sort(), reading.sort());
});
