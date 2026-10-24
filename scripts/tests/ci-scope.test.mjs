import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
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

const workflow = (name) =>
  parse(
    readFileSync(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );

test("scope checkout limits blobs and files while retaining the merge-base graph", (t) => {
  const checkout = workflow("ci").jobs.scope.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with.ref, "${{ github.workflow_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(
    checkout.with["fetch-depth"],
    "${{ (inputs.release || inputs.commit != '') && 1 || 0 }}",
  );
  assert.equal(checkout.with.filter, undefined);
  assert.equal(checkout.with["sparse-checkout-cone-mode"], false);
  const patterns = checkout.with["sparse-checkout"].trim().split("\n");
  assert.deepEqual(patterns, [
    "/scripts/ci-scope.mjs",
    "/scripts/lib/change-scope.mjs",
  ]);

  const repo = repository(t);
  const controls = repo.commit({
    ...Object.fromEntries(
      patterns.map((pattern) => {
        const file = pattern.slice(1);
        return [
          file,
          readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"),
        ];
      }),
    ),
    "README.md": "unrelated root file\n",
    "scripts/unrelated.mjs": "throw new Error('not a control');\n",
    "docs/image.bin": "unrelated image\n",
  });
  const main = git(repo.cwd, "branch", "--show-current");
  git(repo.cwd, "checkout", "--quiet", "-b", "topic");
  const head = repo.commit({ "docs/guide.md": "guide\n" });
  git(repo.cwd, "checkout", "--quiet", main);
  const base = repo.commit({ "packages/a/index.ts": "export const a = 1;\n" });
  git(repo.cwd, "merge", "--quiet", "--no-ff", "-m", "PR merge", "topic");
  const workflowSha = git(repo.cwd, "rev-parse", "HEAD");
  git(repo.cwd, "config", "uploadpack.allowFilter", "true");
  git(repo.cwd, "config", "uploadpack.allowAnySHA1InWant", "true");

  const partial = mkdtempSync(path.join(os.tmpdir(), "covel-ci-partial-"));
  t.after(() => rmSync(partial, { recursive: true, force: true }));
  git(partial, "init", "--quiet");
  git(partial, "remote", "add", "origin", pathToFileURL(repo.cwd).href);
  // The pinned checkout implicitly uses blob:none for sparse checkouts, then
  // configures non-cone patterns before checkout. Reproduce that Git sequence.
  git(
    partial,
    "fetch",
    "--quiet",
    "--filter=blob:none",
    "--no-tags",
    "origin",
    "+refs/heads/*:refs/remotes/origin/*",
  );
  git(partial, "config", "core.sparseCheckout", "true");
  writeFileSync(
    path.join(partial, ".git/info/sparse-checkout"),
    checkout.with["sparse-checkout"],
  );
  git(partial, "checkout", "--quiet", "--detach", workflowSha);
  assert.equal(git(partial, "rev-parse", "--is-shallow-repository"), "false");
  assert.equal(git(partial, "merge-base", base, head), controls);
  for (const file of [
    "README.md",
    "scripts/unrelated.mjs",
    "docs/image.bin",
    "docs/guide.md",
    "packages/a/index.ts",
  ]) {
    assert.equal(existsSync(path.join(partial, file)), false, file);
  }
  const missingBlobs = () =>
    git(partial, "rev-list", "--objects", "--all", "--missing=print")
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .sort();
  const missing = missingBlobs();
  for (const revision of [
    `${repo.base}:packages/a/index.ts`,
    `${base}:packages/a/index.ts`,
    `${head}:docs/guide.md`,
    `${controls}:docs/image.bin`,
  ]) {
    assert.ok(missing.includes(`?${git(repo.cwd, "rev-parse", revision)}`));
  }

  const eventFile = path.join(partial, ".git/event.json");
  for (const [eventName, event, sha, expected] of [
    [
      "pull_request",
      { pull_request: { base: { sha: base }, head: { sha: head } } },
      workflowSha,
      "scope=docs\nsite_deploy=true",
    ],
    [
      "push",
      { before: controls, after: base },
      base,
      "scope=full\nsite_deploy=false",
    ],
  ]) {
    writeFileSync(eventFile, JSON.stringify(event));
    const result = spawnSync(process.execPath, ["scripts/ci-scope.mjs"], {
      cwd: partial,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_SHA: sha,
        RELEASE: "false",
        COMMIT: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
    assert.deepEqual(missingBlobs(), missing, "scope must not fetch blobs");
  }
});

test("CI keeps required Site builds and scoped download keys", () => {
  const ci = workflow("ci");
  const site = workflow("site");
  const release = workflow("release");
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
    (step) => step.name === "Restore site builds",
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
  assert.equal(
    ci.jobs.tests.steps.some((step) =>
      step.with?.path?.includes("covel-node-runtime"),
    ),
    false,
    "desktop uses Electron and must not cache a second Node runtime",
  );
  for (const job of [
    ci.jobs.tests,
    release.jobs["build-electron"],
    release.jobs["build-electron-win"],
  ]) {
    const electron = job.steps.find((step) =>
      /^(Cache|Restore) Electron binaries$/.test(step.name),
    );
    assert.match(electron.with.key, /runner.arch/);
    assert.match(electron.with.key, /pnpm-lock.yaml/);
  }
});

test("static checks and source suites run independently and both feed Verification", () => {
  const { jobs } = workflow("ci");
  for (const name of ["verify", "tests"]) {
    assert.equal(jobs[name].needs, "scope");
    assert.ok(jobs.result.needs.includes(name));
    assert.equal(jobs[name]["continue-on-error"], undefined);
    assert.ok(
      jobs[name].steps.every((step) => step["continue-on-error"] === undefined),
    );
  }
  const find = (job, name) =>
    jobs[job].steps.find((step) => step.name === name);
  assert.equal(find("verify", "Check").run, "pnpm check");
  assert.equal(find("verify", "Check").if, undefined);
  assert.equal(
    find("verify", "Test documentation examples").run,
    "pnpm test:docs:packages",
  );
  assert.equal(
    find("verify", "Release preflight").run,
    "pnpm release:preflight",
  );
  assert.equal(
    find("tests", "Test").run,
    "pnpm test --concurrency=2 --filter=!@covel/web --filter=!@covel/server --filter=!@covel/runtime",
  );
  assert.equal(find("tests", "Test").env.VITEST_MAX_WORKERS, "2");
  assert.equal(
    find("tests", "Build").run,
    "pnpm build --cache=local:r --filter=!@covel/docs --filter=!@covel/site",
  );
  assert.equal(find("tests", "Check"), undefined);
  assert.equal(find("verify", "Test"), undefined);
  for (const scope of ["docs", "full", ""]) {
    for (const release of [false, true]) {
      for (const cancelled of [false, true]) {
        const context = {
          inputs: { release },
          needs: { scope: { outputs: { scope } } },
          success: () => true,
          cancelled: () => cancelled,
        };
        assert.equal(cacheCondition(jobs.verify.if, context), !cancelled);
        const full = scope !== "docs" || release;
        assert.equal(
          cacheCondition(jobs.tests.if, context),
          !cancelled && full,
        );
        assert.equal(cacheCondition(find("tests", "Test").if, context), full);
        assert.equal(
          cacheCondition(find("tests", "Build").if, context),
          !release && scope !== "docs",
        );
        assert.equal(
          cacheCondition(
            find("verify", "Test documentation examples").if,
            context,
          ),
          scope === "docs" && !release,
        );
        assert.equal(
          cacheCondition(find("verify", "Release preflight").if, context),
          release,
        );
      }
    }
  }
});

test("macOS release verifies the shipped GUI before uploading artifacts and preserves failure evidence", () => {
  const { steps } = workflow("release").jobs["build-electron"];
  const smokeIndex = steps.findIndex((step) =>
    step.run?.includes("scripts/verify-mac-artifact.mjs"),
  );
  const uploadIndex = steps.findIndex(
    (step) => step.name === "Upload Electron artifacts",
  );
  assert.ok(smokeIndex >= 0 && uploadIndex > smokeIndex);
  assert.equal(steps[smokeIndex].if, undefined);
  assert.equal(steps[smokeIndex]["continue-on-error"], undefined);
  const evidence = steps.find(
    (step) => step.with?.name === "covel-macos-startup-evidence",
  );
  assert.equal(evidence.if, "always()");
  assert.equal(evidence.with.path, "debugs/mac-artifact-smoke/");
});

// These cache guards use only boolean operators and string equality, whose
// semantics match JavaScript for the typed fixture inputs. Bracket access also
// preserves GitHub's hyphenated step IDs and output names.
function cacheCondition(condition, context) {
  if (condition === undefined) return context.success();
  const expression = condition
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/\.([a-zA-Z_][\w-]*)/g, "['$1']");
  const implicitSuccess =
    /\b(success|failure|cancelled|always)\(/.test(expression) ||
    (context.success?.() ?? true);
  return (
    implicitSuccess && runInNewContext(expression, context, { timeout: 100 })
  );
}

const savesCache = (step) => step.uses?.startsWith("actions/cache/save@");
const restoresCache = (step) => step.uses?.startsWith("actions/cache/restore@");

test("shared caches restore once and save only authorized successful exact misses", () => {
  const ci = workflow("ci");
  const site = workflow("site");
  const cases = [
    {
      steps: ci.jobs.tests.steps,
      id: "electron-cache",
      path: "~/.cache/electron",
      key: "${{ runner.os }}-${{ runner.arch }}-electron-${{ hashFiles('pnpm-lock.yaml') }}",
      prefixes: [],
      skipDocs: true,
    },
    ...["verify", "tests", "web"].map((job) => {
      const prefix = {
        verify: "turbo-check",
        tests: "turbo-test",
        web: "turbo-web",
      }[job];
      return {
        steps: ci.jobs[job].steps,
        id: "turbo-cache",
        path: ".turbo/cache",
        key: `${prefix}-\${{ runner.os }}-\${{ hashFiles('pnpm-lock.yaml') }}-\${{ inputs.commit || github.sha }}`,
        prefixes: [
          `${prefix}-\${{ runner.os }}-\${{ hashFiles('pnpm-lock.yaml') }}-`,
          `${prefix}-\${{ runner.os }}-`,
        ],
      };
    }),
    {
      steps: ci.jobs.browser.steps,
      id: "chromium-cache",
      path: "~/.cache/ms-playwright",
      key: "playwright-${{ runner.os }}-${{ steps.playwright.outputs.image }}-${{ steps.playwright.outputs.version }}",
      prefixes: [],
    },
    {
      steps: site.jobs.build.steps,
      id: "site-cache",
      path: ".turbo/cache",
      key: "turbo-site-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('pnpm-lock.yaml', 'mise.toml') }}-${{ inputs.commit || github.sha }}",
      prefixes: [
        "turbo-site-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('pnpm-lock.yaml', 'mise.toml') }}-",
      ],
      site: true,
    },
  ];
  for (const fixture of cases) {
    const { steps, id } = fixture;
    const [restore] = steps.filter(
      (step) => restoresCache(step) && step.id === id,
    );
    assert.ok(restore, id);
    assert.equal(restore.with.path, fixture.path);
    assert.equal(restore.with.key, fixture.key);
    assert.deepEqual(
      restore.with["restore-keys"]?.trim().split("\n") ?? [],
      fixture.prefixes,
    );
    const saves = steps.filter(
      (step) => savesCache(step) && step.with.path === fixture.path,
    );
    assert.equal(saves.length, 1, id);
    const [save] = saves;
    assert.equal(save.uses, restore.uses.replace("/restore@", "/save@"));
    assert.deepEqual(save.with, {
      path: fixture.path,
      key: `\${{ steps.${id}.outputs.cache-primary-key }}`,
    });
    assert.match(save.if, /success\(\)/);
    assert.ok(
      steps.slice(steps.indexOf(save)).every(savesCache),
      `${save.name} must follow all checks, builds, assembly and uploads`,
    );
    for (const release of fixture.site ? [false] : [false, true]) {
      for (const commit of ["", "a".repeat(40)]) {
        for (const scope of ["docs", "full", ""]) {
          for (const status of ["success", "failure", "cancelled"]) {
            for (const hit of ["true", "false", ""]) {
              const context = {
                inputs: { release, commit },
                needs: { scope: { outputs: { scope } } },
                steps: { [id]: { outputs: { "cache-hit": hit } } },
                success: () => status === "success",
              };
              assert.equal(
                cacheCondition(restore.if, context),
                status === "success" &&
                  (!fixture.skipDocs ||
                    scope !== "docs" ||
                    release ||
                    commit !== ""),
                `${id}: restore ${JSON.stringify({ release, commit, scope, status, hit })}`,
              );
              assert.equal(
                cacheCondition(save.if, context),
                status === "success" &&
                  !release &&
                  commit === "" &&
                  (!fixture.skipDocs || scope !== "docs") &&
                  hit !== "true",
                `${id}: save ${JSON.stringify({ release, commit, scope, status, hit })}`,
              );
            }
          }
        }
      }
    }
  }
  // Prevent a newly added implicit post writer or an untested restore/save pair
  // from bypassing the guards above. Dependency caches retain their own policy.
  for (const [name, definition] of [
    ["ci", ci],
    ["site", site],
  ]) {
    for (const job of Object.values(definition.jobs)) {
      const steps = job.steps ?? [];
      const expected = cases.filter(
        (fixture) => fixture.steps === job.steps,
      ).length;
      assert.equal(steps.filter(savesCache).length, expected);
      assert.equal(steps.filter(restoresCache).length, expected);
      for (const step of steps) {
        assert.ok(!step.uses?.startsWith("actions/cache@"), step.name);
        if (step.uses?.startsWith("actions/setup-node@")) {
          assert.equal(
            step.with.cache,
            name === "ci"
              ? "${{ !inputs.release && inputs.commit == '' && 'pnpm' || '' }}"
              : "${{ inputs.commit == '' && 'pnpm' || '' }}",
          );
          assert.equal(step.with["package-manager-cache"], false);
        }
      }
    }
  }
});

test("Chromium cache hits still install system dependencies and misses download binaries", () => {
  const steps = workflow("ci").jobs.browser.steps;
  const download = steps.find((step) => step.name === "Install Chromium");
  const dependencies = steps.find(
    (step) => step.name === "Install Chromium system packages",
  );
  assert.equal(
    download.run,
    "pnpm exec playwright install --with-deps chromium",
  );
  assert.equal(dependencies.run, "pnpm exec playwright install-deps chromium");
  for (const hit of ["true", "false", ""]) {
    const context = {
      steps: { "chromium-cache": { outputs: { "cache-hit": hit } } },
    };
    assert.equal(cacheCondition(download.if, context), hit !== "true");
    assert.equal(cacheCondition(dependencies.if, context), hit === "true");
  }
});

test("release packaging and explicit-commit Site calls retain read-only cache policy", () => {
  const ci = workflow("ci");
  const release = workflow("release");
  assert.equal(ci.jobs.site.with.commit, "${{ inputs.commit }}");
  assert.equal(ci.jobs.site.if, "${{ !cancelled() && !inputs.release }}");
  for (const job of Object.values(release.jobs)) {
    for (const step of job.steps ?? []) {
      assert.equal(
        /^actions\/cache(?:\/save)?@/.test(step.uses),
        false,
        step.name,
      );
      if (step.uses?.startsWith("actions/setup-node@")) {
        assert.equal(step.with.cache, undefined);
        assert.equal(step.with["package-manager-cache"], false);
      }
      assert.ok(
        !step.with?.path?.includes("covel-node-runtime"),
        "release platforms have no trusted producer for a Node download cache",
      );
    }
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
