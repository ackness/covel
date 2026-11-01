import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { selectCiScope } from "../ci-scope.mjs";

const workflow = (name) =>
  parse(
    readFileSync(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );
const ci = workflow("ci");
const stepWith = (job, command) =>
  job.steps.find((step) => step.run?.includes(command));

// These conditions use only boolean operators, equality and fixture functions.
function selected(condition, context) {
  const expression = condition
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/\.([a-zA-Z_][\w-]*)/g, "['$1']");
  const implicitSuccess =
    /\b(success|failure|cancelled|always)\(/.test(expression) ||
    context.success();
  return (
    implicitSuccess && runInNewContext(expression, context, { timeout: 100 })
  );
}

test("nightly and manual triggers force full scope, including malformed or absent data", () => {
  assert.deepEqual(ci.on.schedule, [{ cron: "17 3 * * *" }]);
  assert.ok(Object.hasOwn(ci.on, "workflow_dispatch"));
  assert.equal(ci.on.workflow_dispatch?.inputs, undefined);
  assert.deepEqual(ci.on.push.branches, ["main"]);
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(ci.on.workflow_call.inputs), [
    "commit",
    "release",
  ]);
  assert.equal(
    ci.concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
  );
  assert.match(
    ci.concurrency.group,
    /github.event_name == 'push'.*github.run_id/,
  );
  assert.equal(ci.on.pull_request?.paths, undefined);
  assert.equal(ci.on.push.paths, undefined);
  for (const eventName of ["schedule", "workflow_dispatch"]) {
    for (const event of [
      undefined,
      null,
      {},
      "invalid",
      { before: "a".repeat(40), after: "b".repeat(40) },
    ]) {
      assert.equal(
        selectCiScope({ cwd: "/missing", eventName, event }).scope,
        "full",
      );
    }
  }
  // Site deployment remains limited to main pushes, regardless of scope.
  assert.match(ci.jobs.site.with.deploy, /github.event_name == 'push'/);
  assert.match(ci.jobs.site.with.deploy, /github.ref == 'refs\/heads\/main'/);
});

test("scope CLI requires full suites for malformed or missing nightly/manual events", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "covel-browser-events-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const payload = join(cwd, "event.json");
  for (const eventName of ["schedule", "workflow_dispatch"]) {
    for (const data of [undefined, "not JSON", "{}", "null"]) {
      if (data === undefined) rmSync(payload, { force: true });
      else writeFileSync(payload, data);
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../ci-scope.mjs", import.meta.url))],
        {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: eventName,
            GITHUB_EVENT_PATH: payload,
            RELEASE: "false",
            COMMIT: "",
          },
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^scope=full\n/);
    }
  }
});

test("every full scope requires all four isolated browser shards and the native aggregate", () => {
  const job = ci.jobs.e2e;
  assert.equal(job.needs, "scope");
  assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job["timeout-minutes"], 40);
  assert.equal(ci.jobs.browser["timeout-minutes"], 25);
  assert.equal(workflow("gate").jobs.gate["timeout-minutes"], 65);
  assert.equal(workflow("gate").jobs.gate.name, "All checks pass");
  assert.ok(ci.jobs.result.needs.includes("e2e"));
  assert.equal(ci.jobs.result.if, "${{ always() }}");
  for (const scope of ["docs", "full", "", undefined]) {
    for (const release of [false, true]) {
      for (const cancelled of [false, true]) {
        const context = {
          needs: { scope: { outputs: { scope } } },
          inputs: { release },
          cancelled: () => cancelled,
          success: () => true,
        };
        for (const lane of [job, ci.jobs.browser])
          assert.equal(
            selected(lane.if, context),
            !cancelled && (scope !== "docs" || release),
          );
      }
    }
  }
  const run = stepWith(job, "--workers=1").run;
  assert.equal(
    run,
    'taskset -c "${{ steps.setup.outputs.cpus }}" pnpm e2e --shard=${{ matrix.shard }}/4 --workers=1',
  );
  assert.doesNotMatch(
    run,
    /--project|--grep|--pass-with-no-tests|E2E_BASE_URL/,
  );
  assert.match(
    stepWith(job, "--list").run,
    /pnpm e2e --shard=\$\{\{ matrix.shard \}\}\/4 --list/,
  );
  for (const lane of [job, ci.jobs.browser]) {
    assert.equal(lane["continue-on-error"], undefined);
    assert.ok(
      lane.steps.every((step) => step["continue-on-error"] === undefined),
    );
    const checkout = lane.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.equal(checkout.with.ref, "${{ inputs.commit || github.sha }}");
    assert.equal(checkout.with["persist-credentials"], false);
    assert.ok(stepWith(lane, "pnpm install --frozen-lockfile"));
    assert.ok(
      stepWith(lane, "pnpm exec playwright install --with-deps chromium"),
    );
    assert.ok(stepWith(lane, "pnpm exec playwright install-deps chromium"));
    const setup = stepWith(lane, "node scripts/e2e-cpu-list.mjs");
    assert.equal(setup.id, "setup");
    assert.match(setup.run, /cpus="\$\(node scripts\/e2e-cpu-list.mjs\)"/);
    assert.match(setup.run, /echo "cpus=\$cpus" >> "\$GITHUB_OUTPUT"/);
    assert.doesNotMatch(setup.run, /\|\| true|0,1/);
    assert.ok(
      lane.steps.indexOf(setup) >
        lane.steps.indexOf(stepWith(lane, "playwright install-deps")),
    );
    assert.ok(
      lane.steps
        .filter((step) => step.run)
        .every((step) => !/LIVE_LLM_ENABLED|E2E_BASE_URL/.test(step.run)),
    );
  }
});

test("acceptance survives smoke failures and stress repeats only nightly or manually", () => {
  const job = ci.jobs.browser;
  const smoke = stepWith(job, "pnpm e2e:smoke");
  const ordinary = job.steps.find(
    (step) =>
      step.run ===
      'taskset -c "${{ steps.setup.outputs.cpus }}" pnpm e2e:extensions',
  );
  const stress = stepWith(job, "--repeat-each=3");
  assert.ok(smoke && ordinary && stress);
  assert.match(smoke.run, /^taskset -c/);
  assert.ok(job.steps.indexOf(smoke) < job.steps.indexOf(ordinary));
  assert.ok(job.steps.indexOf(ordinary) < job.steps.indexOf(stress));
  assert.equal(
    stress.env.PLAYWRIGHT_HTML_OUTPUT_DIR,
    "tests/e2e/report/extensions-stress",
  );
  assert.match(
    stress.run,
    /^taskset -c "\$\{\{ steps.setup.outputs.cpus \}\}" pnpm e2e:extensions tests\/e2e\/sandbox-surfaces.acceptance.ts /,
  );
  assert.match(
    stress.run,
    /--grep 'a delayed runtime approval\|independent sandbox regions'/,
  );
  assert.match(stress.run, /--repeat-each=3 --workers=1 --retries=0/);
  assert.match(stress.run, /--output=tests\/e2e\/artifacts\/extensions-stress/);
  for (const event of [
    "pull_request",
    "push",
    "workflow_call",
    "schedule",
    "workflow_dispatch",
  ]) {
    for (const outcome of ["success", "failure", "skipped"]) {
      for (const failedTest of [false, true]) {
        for (const cancelled of [false, true]) {
          const context = {
            github: { event_name: event },
            steps: { setup: { outcome } },
            cancelled: () => cancelled,
            success: () => !failedTest,
          };
          const ready = !cancelled && outcome === "success";
          assert.equal(selected(ordinary.if, context), ready);
          assert.equal(
            selected(stress.if, context),
            ready && ["schedule", "workflow_dispatch"].includes(event),
          );
        }
      }
    }
  }
});

test("server shards and runtime coverage have independent runners and all block Verification", () => {
  assert.deepEqual(ci.jobs.server.strategy.matrix.shard, [1, 2]);
  assert.equal(ci.jobs.server.strategy["fail-fast"], false);
  assert.match(
    stepWith(ci.jobs.server, "--shard=").run,
    /--shard=\$\{\{ matrix.shard \}\}\/2$/,
  );
  assert.equal(
    stepWith(ci.jobs.runtime, "pnpm test:coverage:runtime").run,
    "pnpm test:coverage:runtime",
  );
  for (const id of ["server", "runtime"]) {
    assert.equal(ci.jobs[id].needs, "scope");
    assert.ok(ci.jobs.result.needs.includes(id));
  }
  assert.equal(
    stepWith(ci.jobs.server, "pnpm test:coverage:runtime"),
    undefined,
  );
});

test("failure uploads retain each lane and shard with unique attempt names", () => {
  for (const name of ["e2e", "browser"]) {
    const job = ci.jobs[name];
    const upload = job.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    assert.equal(upload.if, "${{ failure() }}");
    assert.equal(upload.with["if-no-files-found"], "ignore");
    assert.equal(upload.with["retention-days"], 7);
    assert.match(upload.with.name, /github.run_attempt/);
    assert.match(upload.with.name, /github.run_id/);
    const paths = upload.with.path.trim().split("\n");
    if (name === "e2e") {
      assert.match(upload.with.name, /matrix.shard/);
      assert.deepEqual(paths, ["tests/e2e/artifacts", "tests/e2e/report"]);
    } else {
      for (const lane of ["ci-smoke", "extensions", "extensions-stress"])
        for (const root of ["artifacts", "report"])
          assert.ok(paths.includes(`tests/e2e/${root}/${lane}`));
    }
    assert.ok(
      job.steps.indexOf(upload) >
        job.steps.indexOf(
          stepWith(job, name === "e2e" ? "--workers=1" : "--repeat-each=3"),
        ),
    );
    assert.ok(
      job.steps.every((step) => !/rm\s+-rf.*tests\/e2e/.test(step.run ?? "")),
    );
  }
});
