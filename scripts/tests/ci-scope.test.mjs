import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
  assert.equal(repo.push(docs), "docs");
  const mixed = repo.commit({ "packages/a/index.ts": "export const a = 1;\n" });
  assert.equal(repo.push(mixed), "full");
  assert.equal(repo.push(mixed, docs), "full");
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
  assert.equal(repo.push(renamed, docs), "full");
  const prompt = repo.commit({ "prompts/server/turn.md": "prompt\n" });
  assert.equal(repo.push(prompt, renamed), "full");
});

test("PR scope excludes changes made only on the base branch", (t) => {
  const repo = repository(t);
  const main = git(repo.cwd, "branch", "--show-current");
  git(repo.cwd, "checkout", "--quiet", "-b", "topic");
  const head = repo.commit({ "docs/guide.md": "guide\n" });
  git(repo.cwd, "checkout", "--quiet", main);
  const base = repo.commit({ "packages/a/index.ts": "export const a = 1;\n" });
  const event = { pull_request: { base: { sha: base }, head: { sha: head } } };
  assert.equal(
    selectCiScope({ cwd: repo.cwd, eventName: "pull_request", event }),
    "docs",
  );
  git(repo.cwd, "checkout", "--quiet", "topic");
  event.pull_request.head.sha = repo.commit({
    "plugins/a/PLUGIN.md": "manifest\n",
  });
  assert.equal(
    selectCiScope({ cwd: repo.cwd, eventName: "pull_request", event }),
    "full",
  );
});

test("empty, missing, mismatched and failed diffs cannot opt out of suites", (t) => {
  const repo = repository(t);
  const docs = repo.commit({ "docs/guide.md": "guide\n" });
  assert.equal(repo.push(docs, docs), "full");
  assert.equal(repo.push(docs, "0".repeat(40)), "full");
  assert.equal(repo.push(docs, "f".repeat(40)), "full");
  assert.equal(repo.push(docs, "--invalid-revision"), "full");
  assert.equal(repo.push(docs, undefined, { event: {} }), "full");
  assert.equal(repo.push(docs, undefined, { sha: repo.base }), "full");
  assert.equal(
    repo.push(docs, undefined, { eventName: "workflow_dispatch" }),
    "full",
  );
  assert.equal(
    selectCiScope({ cwd: repo.cwd, eventName: "pull_request", event: {} }),
    "full",
  );
});

test("release and immutable reusable-workflow requests always run full suites", (t) => {
  const repo = repository(t);
  const docs = repo.commit({ "docs/guide.md": "guide\n" });
  assert.equal(repo.push(docs, repo.base, { release: true }), "full");
  assert.equal(repo.push(docs, repo.base, { commit: docs }), "full");
});

test("the workflow command consumes real event payloads and fails closed on unreadable data", (t) => {
  const repo = repository(t);
  const head = repo.commit({ "docs/guide.md": "guide\n" });
  const payload = path.join(repo.cwd, "event.json");
  const run = () =>
    spawnSync(process.execPath, [command], {
      cwd: repo.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: payload,
        GITHUB_SHA: head,
        RELEASE: "false",
        COMMIT: "",
      },
    });
  writeFileSync(payload, JSON.stringify({ before: repo.base, after: head }));
  const docs = run();
  assert.equal(docs.status, 0, docs.stderr);
  assert.equal(docs.stdout.trim(), "scope=docs");
  writeFileSync(payload, "not JSON");
  const malformed = run();
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.equal(malformed.stdout.trim(), "scope=full");
  rmSync(payload);
  assert.equal(run().stdout.trim(), "scope=full");
});
