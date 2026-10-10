import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A repository with a fake pnpm on PATH that records each call, for the
// tests of scripts/check-push.mjs. The tests are split over two files so
// that `node --test` runs them side by side.
const command = fileURLToPath(new URL("../../check-push.mjs", import.meta.url));

export function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function fixture(t) {
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
        COVEL_PUSH_CHECK: "",
        ...options.env,
      };
      // The hook runs this test with its own cache directory in the
      // environment; the fixture starts without one.
      if (!options.env?.TURBO_CACHE_DIR) delete env.TURBO_CACHE_DIR;
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

export const expectedCommands = [
  ["install", "--frozen-lockfile"],
  ["check"],
  ["test", "--concurrency=2"],
  ["e2e", "--list"],
];

export const docsCommands = [
  ["install", "--frozen-lockfile"],
  ["check"],
  ["test:docs"],
];
