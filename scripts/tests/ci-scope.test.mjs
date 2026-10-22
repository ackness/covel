import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { selectCiScope } from "../ci-scope.mjs";
import { git } from "./helpers/check-push-fixture.mjs";

const command = fileURLToPath(new URL("../ci-scope.mjs", import.meta.url));

function repository(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "covel-ci-scope-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.name", "Test User");
  git(cwd, "config", "user.email", "test@example.invalid");
  function commit(files) {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), content);
    }
    git(cwd, "add", "--all");
    git(cwd, "commit", "--quiet", "-m", "change");
    return git(cwd, "rev-parse", "HEAD");
  }
  const base = commit({ "packages/a/index.ts": "export {};\n" });
  const push = (head, before = base, options = {}) =>
    selectCiScope({
      cwd,
      eventName: "push",
      event: { before, after: head },
      sha: head,
      ...options,
    });
  return { cwd, base, commit, push };
}

test("docs, source and mixed pushes select only the suites they can affect", (t) => {
  const repo = repository(t);
  const docs = repo.commit({
    "docs/guide.md": "guide\n",
    "README.md": "readme\n",
  });
  assert.deepEqual(repo.push(docs), { scope: "docs", site_deploy: true });
  const mixed = repo.commit({ "packages/a/index.ts": "export const a = 1;\n" });
  assert.deepEqual(repo.push(mixed), { scope: "full", site_deploy: true });
  assert.deepEqual(repo.push(mixed, docs), {
    scope: "full",
    site_deploy: false,
  });
});

test("prompt manifests and renames out of docs remain source", (t) => {
  const repo = repository(t);
  const docs = repo.commit({ "docs/prompt.md": "prompt\n" });
  mkdirSync(path.join(repo.cwd, "plugins/a"), { recursive: true });
  renameSync(
    path.join(repo.cwd, "docs/prompt.md"),
    path.join(repo.cwd, "plugins/a/PLUGIN.md"),
  );
  const renamed = repo.commit({});
  assert.deepEqual(repo.push(renamed, docs), {
    scope: "full",
    site_deploy: true,
  });
  const prompt = repo.commit({ "prompts/server/turn.md": "prompt\n" });
  assert.deepEqual(repo.push(prompt, renamed), {
    scope: "full",
    site_deploy: false,
  });
});

test("PR scope excludes changes made only on the base branch", (t) => {
  const repo = repository(t);
  const main = git(repo.cwd, "branch", "--show-current");
  git(repo.cwd, "checkout", "--quiet", "-b", "topic");
  const head = repo.commit({ "docs/guide.md": "guide\n" });
  git(repo.cwd, "checkout", "--quiet", main);
  const base = repo.commit({ "packages/a/index.ts": "export const a = 1;\n" });
  const event = { pull_request: { base: { sha: base }, head: { sha: head } } };
  assert.deepEqual(
    selectCiScope({ cwd: repo.cwd, eventName: "pull_request", event }),
    { scope: "docs", site_deploy: true },
  );
  git(repo.cwd, "checkout", "--quiet", "topic");
  event.pull_request.head.sha = repo.commit({
    "plugins/a/PLUGIN.md": "manifest\n",
  });
  assert.deepEqual(
    selectCiScope({ cwd: repo.cwd, eventName: "pull_request", event }),
    { scope: "full", site_deploy: true },
  );
});

test("empty, missing, mismatched and failed diffs cannot opt out of suites", (t) => {
  const repo = repository(t);
  const docs = repo.commit({ "docs/guide.md": "guide\n" });
  const unknown = { scope: "full", site_deploy: true };
  assert.deepEqual(repo.push(docs, docs), unknown);
  assert.deepEqual(repo.push(docs, "0".repeat(40)), unknown);
  assert.deepEqual(repo.push(docs, "f".repeat(40)), unknown);
  assert.deepEqual(repo.push(docs, "--invalid-revision"), unknown);
  assert.deepEqual(repo.push(docs, undefined, { event: {} }), unknown);
  assert.deepEqual(repo.push(docs, undefined, { sha: repo.base }), unknown);
  assert.deepEqual(
    repo.push(docs, undefined, { eventName: "workflow_dispatch" }),
    unknown,
  );
  assert.deepEqual(
    selectCiScope({ cwd: repo.cwd, eventName: "pull_request", event: {} }),
    unknown,
  );
});

test("release and immutable reusable-workflow requests always run full suites", (t) => {
  const repo = repository(t);
  const docs = repo.commit({ "docs/guide.md": "guide\n" });
  assert.deepEqual(repo.push(docs, repo.base, { release: true }), {
    scope: "full",
    site_deploy: false,
  });
  assert.deepEqual(repo.push(docs, repo.base, { commit: docs }), {
    scope: "full",
    site_deploy: true,
  });
  assert.deepEqual(
    selectCiScope({ cwd: "/missing", release: true, commit: repo.base }),
    { scope: "full", site_deploy: false },
  );
});

test("CI keeps required Site builds, PR isolation and release task caches read-only", () => {
  const workflow = (name) =>
    parse(
      readFileSync(
        new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
        "utf8",
      ),
    );
  const ci = workflow("ci");
  const site = workflow("site");
  const release = workflow("release");
  const checkout = ci.jobs.scope.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(
    checkout.with["fetch-depth"],
    "${{ (inputs.release || inputs.commit != '') && 1 || 0 }}",
  );
  assert.equal(ci.jobs.site.if, "${{ !cancelled() && !inputs.release }}");
  assert.ok(ci.jobs.result.needs.includes("site"));
  assert.equal(site.on.pull_request, undefined);
  assert.equal(site.on.push, undefined);
  const build = site.jobs.build.steps.find((step) => step.name === "Build");
  assert.match(
    build.run,
    /pnpm exec turbo build --filter=@covel\/site --filter=@covel\/docs --concurrency=2/,
  );
  assert.match(
    build.run,
    /rm -rf apps\/site\/dist\/docs\n\s*cp -R apps\/docs\/dist apps\/site\/dist\/docs/,
  );
  assert.match(build.env.SITE_BASE, /github.event_name == 'pull_request'/);
  const siteCache = site.jobs.build.steps.find(
    (step) => step.name === "Cache site builds",
  );
  assert.match(siteCache.with.key, /^turbo-site-/);
  assert.equal(siteCache.with.path, ".turbo/cache");
  assert.match(
    site.jobs.deploy.if,
    /inputs.deploy && github.event_name != 'pull_request'/,
  );
  assert.equal(
    site.jobs.build.steps.find((step) => step.name === "Upload Pages artifact")
      .if,
    site.jobs.deploy.if,
  );
  for (const name of ["verify", "web"]) {
    const steps = ci.jobs[name].steps;
    assert.equal(
      steps.find((step) => step.name === "Cache turbo").if,
      "${{ !inputs.release }}",
    );
    const restore = steps.find((step) => step.name === "Restore CI task cache");
    assert.equal(restore.if, "${{ inputs.release }}");
    assert.match(restore.uses, /^actions\/cache\/restore@/);
  }
  for (const job of [
    ci.jobs.verify,
    release.jobs["build-electron"],
    release.jobs["build-electron-win"],
  ]) {
    const cache = job.steps.find(
      (step) => step.name === "Cache verified Node artifacts",
    );
    assert.equal(
      cache.with.path,
      "apps/desktop/node_modules/.cache/covel-node-runtime",
    );
    assert.equal(
      cache.with.key,
      "node-runtime-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('apps/desktop/node-runtime.json', 'mise.toml') }}",
    );
    assert.equal(cache.with["restore-keys"], undefined);
    const electron = job.steps.find(
      (step) => step.name === "Cache Electron binaries",
    );
    assert.match(electron.with.key, /runner.arch/);
    assert.match(electron.with.key, /pnpm-lock.yaml/);
  }
});

test("deployment selection includes site paths and shared build/install controls", (t) => {
  const repo = repository(t);
  let before = repo.base;
  for (const file of [
    "apps/site/src/main.tsx",
    "apps/docs/.vitepress/config.ts",
    "docs/guide.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".pnpmfile.cjs",
    "mise.toml",
    "tsconfig.json",
    "turbo.json",
    "scripts/require-pnpm.mjs",
    "scripts/ci-scope.mjs",
    ".github/workflows/ci.yml",
    ".github/workflows/site.yml",
  ]) {
    const head = repo.commit({ [file]: "changed\n" });
    assert.deepEqual(
      repo.push(head, before),
      { scope: file.startsWith("docs/") ? "docs" : "full", site_deploy: true },
      file,
    );
    before = head;
  }
  rmSync(path.join(repo.cwd, "apps/site/src/main.tsx"));
  const deleted = repo.commit({});
  assert.deepEqual(repo.push(deleted, before), {
    scope: "full",
    site_deploy: true,
  });
});

test("unrelated source and documentation still select suites without publishing", (t) => {
  const repo = repository(t);
  let before = repo.base;
  for (const [file, scope] of [
    ["packages/a/index.ts", "full"],
    ["apps/server/src/index.ts", "full"],
    ["README.md", "docs"],
    ["packages/a/README.md", "docs"],
    [".github/workflows/release.yml", "full"],
  ]) {
    const head = repo.commit({ [file]: "changed\n" });
    assert.deepEqual(
      repo.push(head, before),
      { scope, site_deploy: false },
      file,
    );
    before = head;
  }
});

test("the workflow command consumes real event payloads and fails closed on unreadable data", (t) => {
  const repo = repository(t);
  const head = repo.commit({ "docs/guide.md": "guide\n" });
  const payload = path.join(repo.cwd, "event.json");
  const run = (release = "false") =>
    spawnSync(process.execPath, [command], {
      cwd: repo.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: payload,
        GITHUB_SHA: head,
        RELEASE: release,
        COMMIT: "",
      },
    });
  writeFileSync(payload, JSON.stringify({ before: repo.base, after: head }));
  const docs = run();
  assert.equal(docs.status, 0, docs.stderr);
  assert.equal(docs.stdout.trim(), "scope=docs\nsite_deploy=true");
  writeFileSync(payload, "not JSON");
  const malformed = run();
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.equal(malformed.stdout.trim(), "scope=full\nsite_deploy=true");
  assert.equal(run("true").stdout.trim(), "scope=full\nsite_deploy=false");
  rmSync(payload);
  assert.equal(run().stdout.trim(), "scope=full\nsite_deploy=true");
  assert.equal(run("true").stdout.trim(), "scope=full\nsite_deploy=false");
});
