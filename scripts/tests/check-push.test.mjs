import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../check-push.mjs", import.meta.url));

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "covel-check-push-test-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, "repo");
  const log = path.join(directory, "calls.jsonl");
  git(directory, "init", "--quiet", repo);
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");

  function commit(value) {
    writeFileSync(path.join(repo, "value.txt"), `${value}\n`);
    git(repo, "add", ".gitignore", "value.txt");
    git(repo, "commit", "--quiet", "-m", value);
    return git(repo, "rev-parse", "HEAD");
  }

  const shim = path.join(
    directory,
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  );
  const fakePnpm = path.join(directory, "fake-pnpm.cjs");
  writeFileSync(
    fakePnpm,
    `const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  value: fs.readFileSync("value.txt", "utf8").trim(),
  dirty: fs.existsSync("dirty.txt"),
  ignored: fs.existsSync("ignored.txt"),
  ci: process.env.CI,
  workers: process.env.VITEST_MAX_WORKERS,
  databaseUrl: process.env.DATABASE_URL,
  requirePg: process.env.COVEL_REQUIRE_PG_TESTS,
  gitDir: process.env.GIT_DIR,
}) + "\\n");
if (process.env.FAIL_ON === process.argv.slice(2).join(" ")) process.exit(7);
`,
  );
  writeFileSync(
    shim,
    process.platform === "win32"
      ? `@"${process.execPath}" "${fakePnpm}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fakePnpm}" "$@"\n`,
    { mode: 0o755 },
  );

  return {
    repo,
    commit,
    run(args = [], input = "", options = {}) {
      const env = {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
        DATABASE_URL: "postgresql://fixture.invalid/do-not-use",
        COVEL_REQUIRE_PG_TESTS: "1",
        GIT_DIR: path.join(repo, ".git"),
        FAIL_ON: options.failOn ?? "",
      };
      return spawnSync(process.execPath, [command, ...args], {
        cwd: repo,
        env,
        input,
        encoding: "utf8",
        timeout: 30_000,
      });
    },
    calls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

const expectedCommands = [
  ["install", "--frozen-lockfile"],
  ["check"],
  ["test", "--concurrency=2"],
  ["e2e", "--list"],
];

test("manual check validates committed HEAD in a clean temporary checkout", (t) => {
  const probe = fixture(t);
  probe.commit("committed");
  writeFileSync(path.join(probe.repo, "value.txt"), "dirty\n");
  writeFileSync(path.join(probe.repo, "dirty.txt"), "untracked\n");
  writeFileSync(path.join(probe.repo, "ignored.txt"), "ignored\n");
  const before = git(probe.repo, "status", "--porcelain");

  const result = probe.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = probe.calls();
  assert.deepEqual(
    calls.map(({ args }) => args),
    expectedCommands,
  );
  assert.deepEqual(
    new Set(calls.map(({ value }) => value)),
    new Set(["committed"]),
  );
  for (const call of calls) {
    assert.equal(call.dirty, false);
    assert.equal(call.ignored, false);
    assert.equal(call.ci, "true");
    assert.equal(call.workers, "2");
    assert.equal(call.databaseUrl, undefined);
    assert.equal(call.requirePg, undefined);
    assert.equal(call.gitDir, undefined);
    assert.equal(
      existsSync(call.cwd),
      false,
      "temporary checkout must be removed",
    );
  }
  assert.equal(git(probe.repo, "status", "--porcelain"), before);
  assert.equal(
    readFileSync(path.join(probe.repo, "value.txt"), "utf8"),
    "dirty\n",
  );
});

test("pre-push validates the pushed SHA rather than newer local HEAD", (t) => {
  const probe = fixture(t);
  const old = probe.commit("old");
  const pushed = probe.commit("pushed");
  probe.commit("head");

  const result = probe.run(
    ["--pre-push"],
    `refs/heads/topic ${pushed} refs/heads/topic ${old}\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ value }) => value),
    Array(4).fill("pushed"),
  );
});

test("pre-push skips deleted and unchanged refs and deduplicates pushed commits", (t) => {
  const probe = fixture(t);
  const old = probe.commit("old");
  const pushed = probe.commit("pushed");
  const zeros = "0".repeat(pushed.length);
  const result = probe.run(
    ["--pre-push"],
    [
      `refs/heads/deleted ${zeros} refs/heads/deleted ${old}`,
      `refs/heads/unchanged ${pushed} refs/heads/unchanged ${pushed}`,
      `refs/heads/one ${pushed} refs/heads/one ${old}`,
      `refs/heads/two ${pushed} refs/heads/two ${zeros}`,
      "",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    expectedCommands,
  );
});

test("pre-push validates each distinct changed commit", (t) => {
  const probe = fixture(t);
  const old = probe.commit("old");
  const first = probe.commit("first");
  const second = probe.commit("second");
  const result = probe.run(
    ["--pre-push"],
    `refs/heads/one ${first} refs/heads/one ${old}\nrefs/heads/two ${second} refs/heads/two ${first}\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ value }) => value),
    [...Array(4).fill("first"), ...Array(4).fill("second")],
  );
});

test("pre-push does no work for empty or deletion-only input", (t) => {
  const probe = fixture(t);
  const old = probe.commit("old");
  const zeros = "0".repeat(old.length);
  const empty = probe.run(["--pre-push"]);
  assert.equal(empty.status, 0, empty.stderr);
  const deleted = probe.run(
    ["--pre-push"],
    `refs/heads/deleted ${zeros} refs/heads/deleted ${old}\n`,
  );
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.deepEqual(probe.calls(), []);
});

test("pre-push dereferences annotated tags", (t) => {
  const probe = fixture(t);
  probe.commit("tagged");
  git(probe.repo, "tag", "-a", "v1", "-m", "release");
  const tag = git(probe.repo, "rev-parse", "refs/tags/v1");
  const result = probe.run(
    ["--pre-push"],
    `refs/tags/v1 ${tag} refs/tags/v1 ${"0".repeat(tag.length)}\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ value }) => value),
    Array(4).fill("tagged"),
  );
});

test("failed validation blocks remaining commands and pushed refs", (t) => {
  const probe = fixture(t);
  const old = probe.commit("old");
  const first = probe.commit("first");
  const second = probe.commit("second");
  const before = git(probe.repo, "status", "--porcelain");
  const result = probe.run(
    ["--pre-push"],
    `refs/heads/one ${first} refs/heads/one ${old}\nrefs/heads/two ${second} refs/heads/two ${first}\n`,
    { failOn: "check" },
  );
  assert.notEqual(result.status, 0);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    expectedCommands.slice(0, 2),
  );
  assert.equal(existsSync(probe.calls()[0].cwd), false);
  assert.equal(git(probe.repo, "status", "--porcelain"), before);
});
