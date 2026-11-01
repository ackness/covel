import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Native TypeScript imports only evaluate the configuration; no runner or
// web server is started. Each CI/local import owns a fresh temporary profile.
async function config(file, ci, t) {
  const previous = {
    CI: process.env.CI,
    E2E_BASE_URL: process.env.E2E_BASE_URL,
  };
  let value;
  try {
    process.env.CI = ci ? "true" : "";
    delete process.env.E2E_BASE_URL;
    const url = new URL(`../../${file}`, import.meta.url);
    url.searchParams.set("ci", String(ci));
    value = (await import(url.href)).default;
  } finally {
    for (const [key, setting] of Object.entries(previous)) {
      if (setting === undefined) delete process.env[key];
      else process.env[key] = setting;
    }
  }
  const home = value.webServer.find((server) => server.env?.COVEL_HOME).env
    .COVEL_HOME;
  assert.equal(dirname(home), resolve(tmpdir()));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    assert.equal(existsSync(home), false);
  });
  return value;
}

function ownedServers(value, ci, timeouts) {
  assert.deepEqual(
    value.webServer.map((server) => server.timeout),
    timeouts,
  );
  for (const server of value.webServer) {
    assert.equal(server.reuseExistingServer, false);
    assert.deepEqual(server.gracefulShutdown, {
      signal: "SIGTERM",
      timeout: 5_000,
    });
  }
  const api = value.webServer.find((server) => server.env?.COVEL_HOME);
  assert.equal(api.env.STORE_BACKEND, "memory");
  assert.equal(dirname(api.env.COVEL_HOME), resolve(tmpdir()));
  assert.equal(existsSync(api.env.COVEL_HOME), true);
  assert.equal(value.forbidOnly, ci);
  assert.equal(value.timeout, ci ? 60_000 : 30_000);
  assert.equal(value.expect.timeout, ci ? 10_000 : 5_000);
  assert.equal(value.use.trace, "retain-on-failure");
  assert.equal(value.use.screenshot, "only-on-failure");
}

test("full browser config preserves both automatic routes with bounded CI timings", async (t) => {
  const specsRoot = new URL("../../tests/e2e/", import.meta.url);
  const specs = readdirSync(specsRoot).filter((file) =>
    file.endsWith(".spec.ts"),
  );
  const sourceSpecs = specs.filter((file) =>
    /["'`]\/src\//.test(readFileSync(new URL(file, specsRoot), "utf8")),
  );
  assert.ok(sourceSpecs.length > 0 && sourceSpecs.length < specs.length);
  const homes = new Set();
  for (const ci of [false, true]) {
    const value = await config("playwright.config.ts", ci, t);
    ownedServers(
      value,
      ci,
      ci ? [120_000, 120_000, 180_000] : [60_000, 60_000, 120_000],
    );
    assert.equal(value.fullyParallel, true);
    assert.equal(value.workers, ci ? 1 : undefined);
    assert.equal(value.retries, ci ? 2 : 0);
    assert.deepEqual(
      value.projects.map((project) => project.name),
      ["chromium", "chromium-dev"],
    );
    const [production, dev] = value.projects;
    assert.deepEqual(
      production.testIgnore,
      sourceSpecs.map((file) => `**/${file}`),
    );
    assert.deepEqual(
      dev.testIgnore,
      specs
        .filter((file) => !sourceSpecs.includes(file))
        .map((file) => `**/${file}`),
    );
    assert.equal(production.use.baseURL, "http://127.0.0.1:5183");
    assert.equal(dev.use.baseURL, "http://127.0.0.1:5181");
    assert.equal(dev.expect.timeout, 20_000);
    assert.equal(value.use.video, "on-first-retry");
    assert.ok(value.reporter.some(([reporter]) => reporter === "list"));
    assert.deepEqual(
      value.reporter.find(([reporter]) => reporter === "html")[1],
      { outputFolder: "tests/e2e/report", open: "never" },
    );
    assert.equal(value.outputDir, "./tests/e2e/artifacts");
    homes.add(value.webServer[0].env.COVEL_HOME);
  }
  assert.equal(homes.size, 2, "each invocation owns a fresh profile");
});

test("extension config covers all acceptance files serially with first-failure evidence", async (t) => {
  for (const ci of [false, true]) {
    const value = await config("tests/e2e/third-party-stage.config.ts", ci, t);
    ownedServers(value, ci, ci ? [120_000, 180_000] : [60_000, 120_000]);
    assert.equal(value.testMatch, "**/*.acceptance.ts");
    assert.equal(value.workers, 1);
    assert.equal(value.retries, 0);
    assert.notEqual(value.fullyParallel, true);
    assert.deepEqual(
      value.projects.map((project) => project.name),
      ["chromium"],
    );
    assert.equal(
      value.outputDir,
      resolve(root, "tests/e2e/artifacts/extensions"),
    );
    assert.deepEqual(
      value.reporter.find(([reporter]) => reporter === "html")[1],
      {
        outputFolder: resolve(root, "tests/e2e/report/extensions"),
        open: "never",
      },
    );
    assert.ok(value.reporter.some(([reporter]) => reporter === "list"));
    assert.equal(value.grep, undefined);
    assert.equal(value.testIgnore, undefined);
    assert.equal(value.webServer[0].env.SERVER_PORT, "3102");
    assert.match(value.webServer[1].command, /--port 5182$/);
  }
});
