import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expectedCommands,
  fixture,
  git,
} from "./helpers/check-push-fixture.mjs";

// Which test suites a push runs, and when a commit is not checked again.
// The rules for single files are in push-scope.test.mjs.

/** A workspace of three packages; `b` depends on `a` only in its manifest. */
function workspace(probe) {
  const main = probe.commitFiles(
    {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "turbo.json": JSON.stringify({
        globalDependencies: ["tsconfig.json"],
        tasks: {
          test: { inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/vitest.base.ts"] },
          "c#test": { inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/worlds/**"] },
        },
      }),
      "package.json": JSON.stringify({
        scripts: { "test:docs": "run the documentation tests" },
      }),
      "packages/a/package.json": JSON.stringify({ name: "a" }),
      "packages/b/package.json": JSON.stringify({ name: "b" }),
      "packages/c/package.json": JSON.stringify({ name: "c" }),
      "value.txt": "workspace\n",
    },
    "workspace",
  );
  git(probe.repo, "update-ref", "refs/remotes/origin/main", main);
  return main;
}

function pushTopic(probe, commit, options) {
  return probe.run(
    ["--pre-push", "origin", "url"],
    `refs/heads/topic ${commit} refs/heads/topic ${"0".repeat(commit.length)}\n`,
    options,
  );
}

test("a push runs the tests of the packages it changed, measured from the remote's main branch", (t) => {
  const probe = fixture(t);
  workspace(probe);
  probe.commitFiles({ "packages/a/src/index.ts": "one\n" }, "first");
  // The second commit alone touches another package; both are measured.
  const tip = probe.commitFiles({ "worlds/w/world.yaml": "id: w\n" }, "world");
  const result = pushTopic(probe, tip);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    [
      ["install", "--frozen-lockfile"],
      ["check"],
      ["test", "--concurrency=2", "--filter=...a", "--filter=c"],
      ["e2e", "--list"],
    ],
  );
  assert.match(result.stdout, /Ran: .*\.\.\.a c/);
  assert.match(result.stdout, /Left to CI: the other test suites/);
});

test("a push that changes what every package reads runs every test suite", (t) => {
  // One file of each kind; push-scope.test.mjs lists the rest.
  for (const file of ["vitest.base.ts", "packs/builtin.yaml"]) {
    const probe = fixture(t);
    workspace(probe);
    const tip = probe.commitFiles(
      { "packages/a/src/index.ts": "one\n", [file]: "{}\n" },
      file,
    );
    const result = pushTopic(probe, tip);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      probe.calls().map(({ args }) => args),
      expectedCommands,
      file,
    );
  }
});

test("a push to the main branch, a tag, and a requested full run test everything", (t) => {
  const zeros = "0".repeat(40);
  const cases = [
    (tip) => [`refs/heads/main ${tip} refs/heads/main ${zeros}\n`, {}],
    (tip) => [`refs/tags/v1 ${tip} refs/tags/v1 ${zeros}\n`, {}],
    (tip) => [
      `refs/heads/topic ${tip} refs/heads/topic ${zeros}\n`,
      { env: { COVEL_PUSH_CHECK: "full" } },
    ],
  ];
  for (const input of cases) {
    const probe = fixture(t);
    workspace(probe);
    const tip = probe.commitFiles({ "packages/a/src/index.ts": "one\n" }, "a");
    const [lines, options] = input(tip);
    const result = probe.run(["--pre-push", "origin", "url"], lines, options);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      probe.calls().map(({ args }) => args),
      expectedCommands,
      lines,
    );
  }
});

test("a manual check runs the affected tests, and every suite with --full", (t) => {
  const probe = fixture(t);
  workspace(probe);
  probe.commitFiles({ "packages/b/src/index.ts": "one\n" }, "b");
  const affected = probe.run();
  assert.equal(affected.status, 0, affected.stderr);
  const full = probe.run(["--full"]);
  assert.equal(full.status, 0, full.stderr);
  // A stacked branch is measured from the branch under it.
  probe.commitFiles({ "packages/c/src/index.ts": "one\n" }, "c");
  const stacked = probe.run(["--base", "HEAD~1"]);
  assert.equal(stacked.status, 0, stacked.stderr);
  const unknown = probe.run(["--base", "no-such-branch"]);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    [
      ["install", "--frozen-lockfile"],
      ["check"],
      ["test", "--concurrency=2", "--filter=...b"],
      ["e2e", "--list"],
      ...expectedCommands,
      ["install", "--frozen-lockfile"],
      ["check"],
      ["test", "--concurrency=2", "--filter=...c"],
      ["e2e", "--list"],
      ...expectedCommands,
    ],
  );
});

test("documentation pushed with code adds the tests that read documentation, and no suite when none reads the change", (t) => {
  const probe = fixture(t);
  workspace(probe);
  const tip = probe.commitFiles(
    { "scripts/tool.mjs": "export {};\n", "docs/guide/page.md": "text\n" },
    "script and page",
  );
  const result = pushTopic(probe, tip);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    [
      ["install", "--frozen-lockfile"],
      ["check"],
      ["test:docs"],
      ["e2e", "--list"],
    ],
  );
});

test("a commit that passed is not checked again when its push is repeated", (t) => {
  const probe = fixture(t);
  workspace(probe);
  const tip = probe.commitFiles({ "packages/a/src/index.ts": "one\n" }, "a");
  const first = pushTopic(probe, tip);
  assert.equal(first.status, 0, first.stderr);
  const ran = probe.calls().length;
  assert.equal(ran, 4);

  // The connection closed while the hook ran; the push is sent again.
  const again = pushTopic(probe, tip);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(probe.calls().length, ran);
  assert.match(again.stdout, /passed its checks .* not run again/);
  assert.match(again.stdout, /Left to CI/);

  // The affected tests do not stand for a run of every suite.
  const main = probe.run(
    ["--pre-push", "origin", "url"],
    `refs/heads/main ${tip} refs/heads/main ${"0".repeat(tip.length)}\n`,
  );
  assert.equal(main.status, 0, main.stderr);
  assert.equal(probe.calls().length, ran + expectedCommands.length);

  // A newer commit is checked.
  const next = probe.commitFiles({ "packages/a/src/index.ts": "two\n" }, "a2");
  assert.equal(pushTopic(probe, next).status, 0);
  assert.equal(probe.calls().length, ran + expectedCommands.length + 4);
});

test("a manual check lets the push that follows send at once, and a failed check does not", (t) => {
  const probe = fixture(t);
  workspace(probe);
  const tip = probe.commitFiles({ "packages/a/src/index.ts": "one\n" }, "a");
  assert.notEqual(probe.run([], "", { failOn: "check" }).status, 0);
  assert.equal(pushTopic(probe, tip).status, 0);
  assert.equal(probe.calls().length, 2 + 4);

  const next = probe.commitFiles({ "packages/a/src/index.ts": "two\n" }, "a2");
  assert.equal(probe.run().status, 0);
  assert.equal(pushTopic(probe, next).status, 0);
  assert.equal(probe.calls().length, 2 + 4 + 4);
});
