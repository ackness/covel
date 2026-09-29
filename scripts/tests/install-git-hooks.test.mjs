import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(
  new URL("../install-git-hooks.mjs", import.meta.url),
);

function fixture(t) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "covel-hooks-test-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
  };

  function git(...args) {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  git("init", "--quiet");
  const hooks = path.join(repo, ".git", "hooks");
  const prePush = path.join(hooks, "pre-push");
  return {
    git,
    hooks,
    prePush,
    run() {
      return spawnSync(process.execPath, [command], {
        cwd: repo,
        env,
        encoding: "utf8",
      });
    },
  };
}

test("installs an executable pre-push hook and preserves pre-commit", (t) => {
  const repo = fixture(t);
  const preCommit = path.join(repo.hooks, "pre-commit");
  const original = "#!/bin/sh\necho existing pre-commit\n";
  writeFileSync(preCommit, original, { mode: 0o700 });

  const result = repo.run();
  assert.equal(result.status, 0, result.stderr);
  const hook = readFileSync(repo.prePush, "utf8");
  assert.match(hook, /^#!\/bin\/sh\n/);
  assert.match(
    hook,
    /exec mise exec -- node scripts\/check-push\.mjs --pre-push/,
  );
  assert.notEqual(statSync(repo.prePush).mode & 0o111, 0);
  assert.equal(readFileSync(preCommit, "utf8"), original);
  assert.equal(statSync(preCommit).mode & 0o777, 0o700);
});

test("repeated installation is idempotent", (t) => {
  const repo = fixture(t);
  assert.equal(repo.run().status, 0);
  const original = readFileSync(repo.prePush, "utf8");

  const result = repo.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(repo.prePush, "utf8"), original);
});

test("refuses to overwrite an unknown pre-push hook", (t) => {
  const repo = fixture(t);
  const original = "#!/bin/sh\necho existing pre-push\n";
  writeFileSync(repo.prePush, original, { mode: 0o700 });

  const result = repo.run();
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(repo.prePush, "utf8"), original);
  assert.equal(statSync(repo.prePush).mode & 0o777, 0o700);
});

test("refuses a configured core.hooksPath without writing either hook location", (t) => {
  const repo = fixture(t);
  const customHooks = path.join(path.dirname(repo.hooks), "custom-hooks");
  mkdirSync(customHooks);
  const customPrePush = path.join(customHooks, "pre-push");
  const original = "#!/bin/sh\necho custom pre-push\n";
  writeFileSync(customPrePush, original);
  repo.git("config", "--local", "core.hooksPath", customHooks);

  const result = repo.run();
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(customPrePush, "utf8"), original);
  assert.equal(existsSync(repo.prePush), false);
});

test("refuses an explicitly empty core.hooksPath", (t) => {
  const repo = fixture(t);
  repo.git("config", "--local", "core.hooksPath", "");

  const result = repo.run();
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(repo.prePush), false);
});
