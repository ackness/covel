import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { checkRunsState, verificationFailures } from "../ci-results.mjs";

const command = fileURLToPath(new URL("../ci-results.mjs", import.meta.url));
const fullJobs = ["web", "server", "postgres", "browser"];

function results(scope = "full") {
  return {
    scope: { result: "success", outputs: { scope } },
    verify: { result: "success" },
    site: { result: "success" },
    ...Object.fromEntries(
      fullJobs.map((job) => [
        job,
        { result: scope === "docs" ? "skipped" : "success" },
      ]),
    ),
  };
}

function check(name, conclusion = "success", status = "completed") {
  return { name, conclusion, status, app: { slug: "github-actions" } };
}

const pages = (...runs) => [{ check_runs: runs }];

test("result and merge gate check out only their workflow revision's helper", () => {
  for (const [name, jobName] of [
    ["ci", "result"],
    ["gate", "gate"],
  ]) {
    const workflow = parse(
      readFileSync(
        new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
        "utf8",
      ),
    );
    const steps = workflow.jobs[jobName].steps;
    const checkouts = steps.filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.equal(checkouts.length, 1);
    const [checkout] = checkouts;
    assert.equal(checkout.with.ref, "${{ github.workflow_sha }}");
    assert.equal(checkout.with["persist-credentials"], false);
    assert.equal(checkout.with["fetch-depth"] ?? 1, 1);
    assert.equal(checkout.with.filter, undefined);
    assert.equal(checkout.with["sparse-checkout-cone-mode"], false);
    assert.equal(
      checkout.with["sparse-checkout"].trim(),
      "/scripts/ci-results.mjs",
    );
    assert.ok(
      steps.some((step) => step.run?.includes("node scripts/ci-results.mjs")),
    );
  }
});

test("full and documentation-only verification require their actual job results", () => {
  assert.deepEqual(verificationFailures(results()), []);
  assert.deepEqual(verificationFailures(results("docs")), []);
  assert.notDeepEqual(verificationFailures(results("docs"), true), []);
  const release = results();
  release.site.result = "skipped";
  assert.deepEqual(verificationFailures(release, true), []);
  assert.notDeepEqual(verificationFailures(release), []);
});

test("failure, cancellation, unknown, skipped and missing required jobs never pass", () => {
  for (const scope of ["docs", "full"]) {
    const required = [
      "scope",
      "verify",
      "site",
      ...(scope === "full" ? fullJobs : []),
    ];
    for (const job of required) {
      for (const status of [
        "failure",
        "cancelled",
        "skipped",
        "unknown",
        undefined,
      ]) {
        const needs = results(scope);
        if (status === undefined) delete needs[job];
        else needs[job].result = status;
        assert.notDeepEqual(
          verificationFailures(needs),
          [],
          `${scope}: ${job} ${status}`,
        );
      }
    }
  }
  for (const scope of [undefined, "", "unknown"]) {
    const needs = results();
    needs.scope.outputs.scope = scope;
    assert.notDeepEqual(verificationFailures(needs), []);
  }
  assert.notDeepEqual(verificationFailures(undefined), []);
});

test("optional docs-path suites may skip but cannot hide a failure or missing result", () => {
  for (const job of fullJobs) {
    for (const result of ["failure", "cancelled", "unknown", undefined]) {
      const needs = results("docs");
      needs[job].result = result;
      assert.notDeepEqual(verificationFailures(needs), []);
    }
  }
});

test("release may skip Site but cannot hide its failure, cancellation or missing result", () => {
  for (const result of ["failure", "cancelled", "unknown", undefined]) {
    const needs = results();
    if (result === undefined) delete needs.site;
    else needs.site.result = result;
    assert.notDeepEqual(verificationFailures(needs, true), [], String(result));
  }
  for (const job of ["verify", ...fullJobs]) {
    const needs = results();
    needs.site.result = "skipped";
    needs[job].result = "skipped";
    assert.notDeepEqual(verificationFailures(needs, true), [], job);
  }
});

test("a quiet Checks API is not proof that verification ran", () => {
  assert.equal(checkRunsState([]), "pending");
  assert.equal(checkRunsState(pages()), "pending");
  assert.equal(checkRunsState(pages(check("Site"))), "pending");
  assert.equal(
    checkRunsState(pages(check("All checks pass", null, "in_progress"))),
    "pending",
  );
  const otherApp = check("Verification");
  otherApp.app.slug = "another-app";
  assert.equal(checkRunsState(pages(otherApp)), "pending");
});

test("the required aggregate must succeed, never skip or become neutral", () => {
  for (const conclusion of [
    "failure",
    "cancelled",
    "skipped",
    "neutral",
    "timed_out",
    "action_required",
    null,
    "unknown",
  ]) {
    assert.equal(
      checkRunsState(pages(check("Verification", conclusion))),
      "failure",
      String(conclusion),
    );
  }
  for (const status of [
    "queued",
    "in_progress",
    "waiting",
    "pending",
    "requested",
  ]) {
    assert.equal(
      checkRunsState(pages(check("Verification", null, status))),
      "pending",
    );
  }
  assert.equal(
    checkRunsState(pages(check("Verification", null, "unknown"))),
    "failure",
  );
  assert.equal(checkRunsState(pages(check("Verification"))), "success");
});

test("Site and unrelated failures still block across API pages", () => {
  const verification = pages(check("Verification"));
  assert.equal(
    checkRunsState([...verification, ...pages(check("Site", "failure"))]),
    "failure",
  );
  assert.equal(
    checkRunsState([...verification, ...pages(check("Other", "cancelled"))]),
    "failure",
  );
  assert.equal(
    checkRunsState([
      ...verification,
      ...pages(check("Site", null, "in_progress")),
    ]),
    "pending",
  );
  assert.equal(
    checkRunsState([
      ...verification,
      ...pages(check("Site", "skipped"), check("Other", "neutral")),
    ]),
    "success",
  );
  assert.equal(
    checkRunsState([
      ...verification,
      ...pages(check("Verification", "failure")),
    ]),
    "failure",
  );
  assert.throws(() => checkRunsState({ check_runs: [] }), /Invalid/);
  assert.throws(() => checkRunsState([{}]), /Invalid/);
});

test("workflow entrypoints reject failed native results and consume API payloads", () => {
  const aggregate = (needs, release = false) =>
    spawnSync(process.execPath, [command, "verification"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEEDS: JSON.stringify(needs),
        RELEASE: String(release),
      },
    });
  assert.equal(aggregate(results("docs")).status, 0);
  const skipped = results();
  skipped.verify.result = "skipped";
  assert.equal(aggregate(skipped).status, 1);
  for (const result of ["skipped", "failure", "cancelled", undefined]) {
    const needs = results("docs");
    if (result === undefined) delete needs.site;
    else needs.site.result = result;
    const failed = aggregate(needs);
    assert.equal(failed.status, 1, String(result));
    assert.match(failed.stderr, /site did not succeed/);
  }
  const release = results();
  release.site.result = "skipped";
  assert.equal(aggregate(release, true).status, 0);
  const poll = (payload) =>
    spawnSync(process.execPath, [command, "checks"], {
      encoding: "utf8",
      input: payload,
    });
  assert.equal(
    poll(JSON.stringify(pages(check("Site")))).stdout.trim(),
    "pending",
  );
  assert.equal(
    poll(JSON.stringify(pages(check("Verification")))).stdout.trim(),
    "success",
  );
  assert.equal(poll("not JSON").status, 1);
});
