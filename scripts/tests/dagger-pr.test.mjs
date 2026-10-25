import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { selectCiRunner } from "../ci-runner.mjs";
import {
  checkIdentity,
  eligibleOwnerPr,
  remoteCheckState,
} from "../lib/dagger-pr-policy.mjs";
import {
  pipelineQuery,
  postgresQuery,
  queryLeaf,
  tasksForScope,
} from "../lib/dagger-pipeline.mjs";
import { verificationFailures } from "../ci-results.mjs";

const sha = "a".repeat(40);
const repo = { id: 1190560481, full_name: "ackness/covel" };
function pr() {
  return {
    number: 123,
    state: "open",
    user: { id: 19150500, login: "ackness" },
    base: { repo: { ...repo }, ref: "main", sha },
    head: { repo: { ...repo }, sha: "b".repeat(40) },
  };
}

test("Dagger access requires both immutable owner identity and same-repository code", () => {
  assert.equal(eligibleOwnerPr(pr()), true);
  for (const mutate of [
    (p) => {
      p.user.id = 1;
    },
    (p) => {
      p.user.login = "outsider";
    },
    (p) => {
      p.head.repo.id = 1;
    },
    (p) => {
      p.head.repo.full_name = "outsider/covel";
    },
    (p) => {
      p.head.repo = null;
    },
    (p) => {
      p.base.ref = "other";
    },
    (p) => {
      p.base.repo.id = 1;
    },
    (p) => {
      p.state = "closed";
    },
    (p) => {
      p.head.sha = "main; echo untrusted";
    },
  ]) {
    const value = pr();
    mutate(value);
    assert.equal(eligibleOwnerPr(value), false);
  }
  assert.equal(eligibleOwnerPr(null), false);
});

test("routing stays on GitHub until the trusted executor is on the base commit", (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "covel-dagger-route-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(path.join(cwd, "README.md"), "test");
  git("add", ".");
  git("commit", "-qm", "base");
  const event = { pull_request: pr() };
  event.pull_request.base.sha = git("rev-parse", "HEAD");
  const options = { cwd, eventName: "pull_request", event };
  assert.equal(selectCiRunner(options), "github");
  mkdirSync(path.join(cwd, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(cwd, ".github/workflows/dagger-pr.yml"), "trusted");
  git("add", ".");
  git("commit", "-qm", "executor");
  // A file only in the PR/worktree must not activate delegation.
  assert.equal(selectCiRunner(options), "github");
  event.pull_request.base.sha = git("rev-parse", "HEAD");
  assert.equal(selectCiRunner(options), "dagger");
  for (const extra of [
    { release: true },
    { commit: sha },
    { eventName: "push" },
    { eventName: "workflow_call" },
  ])
    assert.equal(selectCiRunner({ ...options, ...extra }), "github");
});

test("only the newest authorized check for the exact merge commit can pass", () => {
  const identity = checkIdentity(123, sha);
  const check = {
    id: 1,
    name: "Dagger Linux",
    app: { slug: "github-actions" },
    external_id: identity,
    status: "completed",
    conclusion: "success",
  };
  assert.equal(remoteCheckState([], identity), "pending");
  assert.equal(remoteCheckState([check], identity), "success");
  assert.equal(
    remoteCheckState([check], checkIdentity(123, "c".repeat(40))),
    "pending",
  );
  assert.equal(
    remoteCheckState([{ ...check, app: { slug: "untrusted" } }], identity),
    "pending",
  );
  for (const conclusion of [
    "skipped",
    "neutral",
    "failure",
    "cancelled",
    "timed_out",
    null,
  ])
    assert.equal(
      remoteCheckState([{ ...check, conclusion }], identity),
      "failure",
    );
  assert.equal(
    remoteCheckState(
      [check, { ...check, id: 2, status: "in_progress", conclusion: null }],
      identity,
    ),
    "pending",
  );
  assert.equal(
    remoteCheckState(
      [{ ...check, id: 2, conclusion: "failure" }, check],
      identity,
    ),
    "failure",
  );
});

test("Verification fails closed when the remote result is missing, skipped or failed", () => {
  const native = [
    "verify",
    "site",
    "tests",
    "web",
    "server",
    "postgres",
    "browser",
  ];
  const needs = {
    scope: { result: "success", outputs: { scope: "full", runner: "dagger" } },
    dagger: { result: "success" },
    ...Object.fromEntries(native.map((name) => [name, { result: "skipped" }])),
  };
  assert.deepEqual(verificationFailures(needs), []);
  for (const result of ["skipped", "failure", "cancelled", undefined])
    assert.notDeepEqual(
      verificationFailures({ ...needs, dagger: { result } }),
      [],
    );
  assert.notDeepEqual(verificationFailures(needs, true), []);
  assert.notDeepEqual(
    verificationFailures({ ...needs, web: { result: "failure" } }),
    [],
  );
});

test("remote pipelines preserve Linux CI gates and isolate code from controller capabilities", () => {
  assert.deepEqual(tasksForScope("docs"), ["verify", "site"]);
  assert.equal(tasksForScope("full").length, 7);
  assert.throws(() => tasksForScope("unknown"));
  const queries = Object.fromEntries(
    tasksForScope("full").map((task) => [
      task,
      pipelineQuery({
        sha,
        scope: "full",
        task,
        nonce: "run-1",
        postgresId: "test-service",
        artifactDir: "/tmp/artifacts",
      }),
    ]),
  );
  for (const query of Object.values(queries)) {
    assert.match(query, /disableDaggerInDagger:true/);
    assert.equal(
      (query.match(/withExec\(/g) ?? []).length,
      (query.match(/disableDaggerInDagger:true/g) ?? []).length,
    );
    assert.doesNotMatch(
      query,
      /withMountedDirectory|withSecretVariable|insecureRootCapabilities:true|host\(/,
    );
    assert.match(query, /git fetch --depth=1 origin a{40}/);
    assert.match(query, /name:"CI_RUN",value:"run-1"/);
  }
  assert.match(queries.verify, /pnpm check/);
  assert.match(queries.server, /pnpm test:coverage:runtime/);
  assert.match(
    queries.tests,
    /--filter=!@covel\/server --filter=!@covel\/runtime/,
  );
  assert.match(queries.tests, /pnpm build --cache=local:r/);
  assert.match(queries.postgres, /withServiceBinding/);
  assert.match(queries.postgres, /pnpm test:pg/);
  assert.match(
    queries.browser,
    /pnpm e2e --list && pnpm e2e:smoke && pnpm e2e:extensions/,
  );
  assert.match(queries.site, /--filter=@covel\/site --filter=@covel\/docs/);
  assert.match(postgresQuery("run-1"), /pgvector\/pgvector:0.8.7-pg18@sha256:/);
  assert.match(
    postgresQuery("run-1"),
    /asService\(disableDaggerInDagger:true\)/,
  );
  assert.throws(() =>
    pipelineQuery({
      sha: "main;evil",
      scope: "full",
      task: "verify",
      nonce: "x",
    }),
  );
  assert.deepEqual(queryLeaf({ container: { withExec: { exitCode: 1 } } }), {
    exitCode: 1,
  });
});

test("PR workflows keep credentials on main and native CI retains a required remote gate", () => {
  const read = (name) =>
    parse(
      readFileSync(
        new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
        "utf8",
      ),
    );
  const remote = read("dagger-pr");
  assert.deepEqual(remote.on.pull_request_target.branches, ["main"]);
  assert.match(remote.jobs.linux.if, /head.repo.id == 1190560481/);
  assert.match(remote.jobs.linux.if, /user.id == 19150500/);
  assert.equal(remote.jobs.linux.environment, "dagger-ci");
  const checkout = remote.jobs.linux.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with.ref, "${{ github.workflow_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const run = remote.jobs.linux.steps.find((step) => step.id === "run");
  assert.equal(run.env.GH_TOKEN, undefined);
  assert.match(run.run, /unset DAGGER_CLIENT_CERT DAGGER_CLIENT_KEY/);
  assert.ok(
    remote.jobs.linux.steps.some(
      (step) =>
        step.run === "node scripts/dagger-pr.mjs complete" &&
        step.if.includes("always()"),
    ),
  );
  const ci = read("ci");
  assert.ok(ci.jobs.result.needs.includes("dagger"));
  for (const job of [
    "verify",
    "site",
    "tests",
    "web",
    "server",
    "postgres",
    "browser",
  ])
    assert.match(ci.jobs[job].if, /needs.scope.outputs.runner != 'dagger'/);
  assert.equal(ci.jobs.dagger.permissions.checks, "read");
  assert.equal(ci.jobs.dagger.environment, undefined);
});
