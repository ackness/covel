import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ scripts: { "test:docs": "run the documentation tests" } }),
  );

  function commit(value) {
    writeFileSync(path.join(repo, "value.txt"), `${value}\n`);
    git(repo, "add", ".gitignore", "package.json", "value.txt");
    git(repo, "commit", "--quiet", "-m", value);
    return git(repo, "rev-parse", "HEAD");
  }

  function commitFiles(files, message) {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), content);
    }
    git(repo, "add", ...Object.keys(files));
    git(repo, "commit", "--quiet", "-m", message);
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
  turboCacheDir: process.env.TURBO_CACHE_DIR,
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
    commitFiles,
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

const docsCommands = [
  ["install", "--frozen-lockfile"],
  ["check"],
  ["test:docs"],
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
    // Task results come from the cache the repository's worktrees share.
    assert.equal(
      call.turboCacheDir,
      path.join(realpathSync(probe.repo), ".turbo", "cache"),
    );
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

test("a push that adds only documentation skips the test suites that cannot change", (t) => {
  const probe = fixture(t);
  const code = probe.commit("code");
  const docs = probe.commitFiles(
    {
      "docs/guide/page.md": "text\n",
      "README.md": "text\n",
      "plugins/a/README.md": "text\n",
      ".claude/skills/a/SKILL.md": "text\n",
    },
    "docs",
  );
  const result = probe.run(
    ["--pre-push", "origin", "url"],
    `refs/heads/topic ${docs} refs/heads/topic ${code}\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    docsCommands,
  );
});

test("a push that adds documentation and code runs every check", (t) => {
  const probe = fixture(t);
  const base = probe.commit("base");
  probe.commitFiles({ "docs/guide/page.md": "text\n" }, "docs");
  // Markdown that a loader reads is source.
  const mixed = probe.commitFiles(
    { "plugins/a/PLUGIN.md": "---\nid: a\n---\n" },
    "manifest",
  );
  const result = probe.run(
    ["--pre-push", "origin", "url"],
    `refs/heads/topic ${mixed} refs/heads/topic ${base}\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    expectedCommands,
  );
});

test("a new branch is measured from the remote's main branch", (t) => {
  const probe = fixture(t);
  const main = probe.commit("main");
  const docs = probe.commitFiles({ "docs/page.md": "text\n" }, "docs");
  const zeros = "0".repeat(docs.length);
  const input = `refs/heads/topic ${docs} refs/heads/topic ${zeros}\n`;

  // Without the remote's main branch there is nothing to measure from.
  const unknown = probe.run(["--pre-push", "origin", "url"], input);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    expectedCommands,
  );

  git(probe.repo, "update-ref", "refs/remotes/origin/main", main);
  const known = probe.run(["--pre-push", "origin", "url"], input);
  assert.equal(known.status, 0, known.stderr);
  assert.deepEqual(
    probe
      .calls()
      .slice(expectedCommands.length)
      .map(({ args }) => args),
    docsCommands,
  );
});

test("a commit that adds code to one of its refs runs every check", (t) => {
  const probe = fixture(t);
  const base = probe.commit("base");
  const code = probe.commit("code");
  const docs = probe.commitFiles({ "docs/page.md": "text\n" }, "docs");
  const result = probe.run(
    ["--pre-push", "origin", "url"],
    `refs/heads/one ${docs} refs/heads/one ${code}\nrefs/heads/two ${docs} refs/heads/two ${base}\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    expectedCommands,
  );
});

test("a pushed commit from before the documentation tests existed runs every check", (t) => {
  const probe = fixture(t);
  probe.commit("code");
  const old = probe.commitFiles({ "package.json": "{}" }, "no test:docs");
  const docs = probe.commitFiles({ "docs/page.md": "text\n" }, "docs");
  const result = probe.run(
    ["--pre-push", "origin", "url"],
    `refs/heads/topic ${docs} refs/heads/topic ${old}\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    expectedCommands,
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
