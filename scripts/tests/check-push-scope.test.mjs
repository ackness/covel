import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  docsCommands,
  expectedCommands,
  fixture,
  git,
  staticCommands,
} from "./helpers/check-push-fixture.mjs";

// Which test suites a check runs, and when a commit is not checked again. The
// hook runs the static gate alone; `COVEL_PUSH_CHECK=affected` gives it the
// selection a manual check uses. The rules for single files are in
// push-scope.test.mjs.

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
        scripts: {
          "test:docs": "run the documentation tests",
          "test:docs:packages": "run the package documentation tests",
        },
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

const affectedRun = { env: { COVEL_PUSH_CHECK: "affected" } };

function pushTopic(probe, commit, options) {
  return probe.run(
    ["--pre-push", "origin", "url"],
    `refs/heads/topic ${commit} refs/heads/topic ${"0".repeat(commit.length)}\n`,
    options,
  );
}

test("a push of code to a branch runs the static gate and leaves the tests to CI", (t) => {
  const probe = fixture(t);
  workspace(probe);
  const tip = probe.commitFiles({ "packages/a/src/index.ts": "one\n" }, "a");
  const result = pushTopic(probe, tip);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    staticCommands,
  );
  assert.match(result.stdout, /Ran: the static gate\./);
  assert.match(result.stdout, /Left to CI: every test suite/);
});

test("a push asked for the affected tests runs those of the packages it changed, measured from the remote's main branch", (t) => {
  const probe = fixture(t);
  workspace(probe);
  probe.commitFiles({ "packages/a/src/index.ts": "one\n" }, "first");
  // The second commit alone touches another package; both are measured.
  const tip = probe.commitFiles({ "worlds/w/world.yaml": "id: w\n" }, "world");
  const result = pushTopic(probe, tip, affectedRun);
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

test("an affected run that changes what every package reads runs every test suite", (t) => {
  // One file of each kind; push-scope.test.mjs lists the rest.
  for (const file of ["vitest.base.ts", "packs/builtin.yaml"]) {
    const probe = fixture(t);
    workspace(probe);
    const tip = probe.commitFiles(
      { "packages/a/src/index.ts": "one\n", [file]: "{}\n" },
      file,
    );
    const result = pushTopic(probe, tip, affectedRun);
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

test("full requests, main and tags override a docs-only result and its cache", (t) => {
  for (const kind of ["full", "main", "tag"]) {
    const probe = fixture(t);
    const base = workspace(probe);
    const tip = probe.commitFiles({ "docs/page.md": "text\n" }, "docs");
    assert.equal(pushTopic(probe, tip).status, 0);
    const previous = probe.calls().length;
    const ref =
      kind === "tag"
        ? "refs/tags/v1"
        : `refs/heads/${kind === "main" ? "main" : "topic"}`;
    const result = probe.run(
      ["--pre-push", "origin", "url"],
      `${ref} ${tip} ${ref} ${kind === "tag" ? "0".repeat(40) : base}\n`,
      { env: { COVEL_PUSH_CHECK: kind === "full" ? "full" : "" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      probe
        .calls()
        .slice(previous)
        .map(({ args }) => args),
      expectedCommands,
      kind,
    );
  }
});

test("an affected check for a stacked base cannot satisfy a wider push", (t) => {
  const probe = fixture(t);
  workspace(probe);
  probe.commitFiles({ "packages/a/src/index.ts": "one\n" }, "a");
  const tip = probe.commitFiles({ "packages/b/src/index.ts": "one\n" }, "b");
  const narrowed = probe.run(["--base", "HEAD~1"]);
  assert.equal(narrowed.status, 0, narrowed.stderr);
  assert.deepEqual(probe.calls()[2].args, [
    "test",
    "--concurrency=2",
    "--filter=...b",
  ]);
  const previous = probe.calls().length;
  const wider = pushTopic(probe, tip, affectedRun);
  assert.equal(wider.status, 0, wider.stderr);
  assert.deepEqual(
    probe
      .calls()
      .slice(previous)
      .map(({ args }) => args),
    [
      ["install", "--frozen-lockfile"],
      ["check"],
      ["test", "--concurrency=2", "--filter=...a", "--filter=...b"],
      ["e2e", "--list"],
    ],
  );
  const afterWider = probe.calls().length;
  assert.equal(pushTopic(probe, tip, affectedRun).status, 0);
  assert.equal(
    probe.calls().length,
    afterWider,
    "the same base can reuse the affected result",
  );
});

test("affected results for the same HEAD retain each base for later hooks", (t) => {
  const probe = fixture(t);
  const main = workspace(probe);
  const stacked = probe.commitFiles(
    { "packages/a/src/index.ts": "one\n" },
    "a",
  );
  const tip = probe.commitFiles({ "packages/b/src/index.ts": "one\n" }, "b");

  const first = probe.run();
  assert.equal(first.status, 0, first.stderr);
  const second = probe.run(["--base", stacked]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    [
      ...staticCommands,
      ["test", "--concurrency=2", "--filter=...a", "--filter=...b"],
      ["e2e", "--list"],
      ...staticCommands,
      ["test", "--concurrency=2", "--filter=...b"],
      ["e2e", "--list"],
    ],
  );

  const previous = probe.calls().length;
  for (const base of [main, stacked]) {
    git(probe.repo, "update-ref", "refs/remotes/origin/main", base);
    const cached = pushTopic(probe, tip, affectedRun);
    assert.equal(cached.status, 0, cached.stderr);
    assert.equal(probe.calls().length, previous, base);
    assert.match(cached.stdout, /passed its checks .* not run again/);
  }
});

for (const first of ["docs", "affected"]) {
  test(`${first} followed by the other check retains both docs and affected results`, (t) => {
    const probe = fixture(t);
    workspace(probe);
    const code = probe.commitFiles({ "packages/a/src/index.ts": "one\n" }, "a");
    const tip = probe.commitFiles({ "docs/page.md": "text\n" }, "docs");
    const checks = {
      docs: {
        run: () =>
          probe.run(
            ["--pre-push", "origin", "url"],
            `refs/heads/topic ${tip} refs/heads/topic ${code}\n`,
          ),
        commands: docsCommands,
      },
      affected: {
        run: () => pushTopic(probe, tip, affectedRun),
        commands: [
          ...staticCommands,
          ["test", "--concurrency=2", "--filter=...a"],
          ["test:docs:packages"],
          ["e2e", "--list"],
        ],
      },
    };
    const order = [first, first === "docs" ? "affected" : "docs"];
    for (const kind of order) {
      const previous = probe.calls().length;
      const result = checks[kind].run();
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        probe
          .calls()
          .slice(previous)
          .map(({ args }) => args),
        checks[kind].commands,
        `${kind} must run despite the other cached check`,
      );
    }

    const previous = probe.calls().length;
    for (const kind of order) {
      const cached = checks[kind].run();
      assert.equal(cached.status, 0, cached.stderr);
      assert.equal(probe.calls().length, previous, kind);
      assert.match(cached.stdout, /passed its checks .* not run again/);
    }
  });
}

test("a full result replaces all covered records for its commit and satisfies every hook scope", (t) => {
  const probe = fixture(t);
  const main = workspace(probe);
  const stacked = probe.commitFiles(
    { "packages/a/src/index.ts": "one\n" },
    "a",
  );
  const code = probe.commitFiles({ "packages/b/src/index.ts": "one\n" }, "b");
  const tip = probe.commitFiles({ "docs/page.md": "text\n" }, "docs");
  const docsInput = `refs/heads/topic ${tip} refs/heads/topic ${code}\n`;

  assert.equal(pushTopic(probe, stacked).status, 0);
  assert.equal(probe.run(["--pre-push", "origin", "url"], docsInput).status, 0);
  assert.equal(probe.run().status, 0);
  assert.equal(probe.run(["--base", stacked]).status, 0);

  const previous = probe.calls().length;
  const full = probe.run(["--full"]);
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(
    probe
      .calls()
      .slice(previous)
      .map(({ args }) => args),
    expectedCommands,
  );
  const entries = JSON.parse(
    readFileSync(
      path.join(probe.repo, ".git", "covel-push-verified.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    entries.map(({ commit, level, base }) => ({ commit, level, base })),
    [
      { commit: stacked, level: "static", base: undefined },
      { commit: tip, level: "full", base: undefined },
    ],
  );

  const afterFull = probe.calls().length;
  const cachedChecks = [
    () => pushTopic(probe, tip),
    () => probe.run(["--pre-push", "origin", "url"], docsInput),
    () => pushTopic(probe, tip, affectedRun),
    () =>
      probe.run(
        ["--pre-push", "origin", "url"],
        `refs/heads/main ${tip} refs/heads/main ${main}\n`,
      ),
  ];
  for (const run of cachedChecks) {
    const cached = run();
    assert.equal(cached.status, 0, cached.stderr);
    assert.equal(probe.calls().length, afterFull);
    assert.match(cached.stdout, /passed its checks .* not run again/);
  }
  git(probe.repo, "update-ref", "refs/remotes/origin/main", stacked);
  const otherBase = pushTopic(probe, tip, affectedRun);
  assert.equal(otherBase.status, 0, otherBase.stderr);
  assert.equal(probe.calls().length, afterFull);
  assert.match(otherBase.stdout, /passed its checks .* not run again/);
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
  const result = pushTopic(probe, tip, affectedRun);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    probe.calls().map(({ args }) => args),
    [
      ["install", "--frozen-lockfile"],
      ["check"],
      ["test:docs:packages"],
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
  assert.equal(ran, staticCommands.length);

  // The connection closed while the hook ran; the push is sent again.
  const again = pushTopic(probe, tip);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(probe.calls().length, ran);
  assert.match(again.stdout, /passed its checks .* not run again/);
  assert.match(again.stdout, /Left to CI/);

  // The static gate does not stand for a run of every suite.
  const main = probe.run(
    ["--pre-push", "origin", "url"],
    `refs/heads/main ${tip} refs/heads/main ${"0".repeat(tip.length)}\n`,
  );
  assert.equal(main.status, 0, main.stderr);
  assert.equal(probe.calls().length, ran + expectedCommands.length);

  // A newer commit is checked.
  const next = probe.commitFiles({ "packages/a/src/index.ts": "two\n" }, "a2");
  assert.equal(pushTopic(probe, next).status, 0);
  assert.equal(
    probe.calls().length,
    ran + expectedCommands.length + staticCommands.length,
  );
});

test("a manual check lets the push that follows send at once, and a failed check does not", (t) => {
  const probe = fixture(t);
  workspace(probe);
  const tip = probe.commitFiles({ "packages/a/src/index.ts": "one\n" }, "a");
  assert.notEqual(probe.run([], "", { failOn: "check" }).status, 0);
  assert.equal(pushTopic(probe, tip).status, 0);
  assert.equal(probe.calls().length, 2 + staticCommands.length);

  const next = probe.commitFiles({ "packages/a/src/index.ts": "two\n" }, "a2");
  assert.equal(probe.run().status, 0);
  assert.equal(pushTopic(probe, next).status, 0);
  // The manual check ran more than the push needs.
  assert.equal(probe.calls().length, 2 + staticCommands.length + 4);
});
