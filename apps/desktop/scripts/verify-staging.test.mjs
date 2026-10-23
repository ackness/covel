import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

// Run the actual verifier and its HTTP/shutdown helpers. Only packaging checks
// are replaced: the fixture is an ordinary Node child, with real HTTP and IPC.
test("staging verification reaps its child before removing SQLite files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-verify-staging-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources");
  const server = path.join(resources, "server");
  fs.mkdirSync(path.join(server, "src"), { recursive: true });
  fs.mkdirSync(path.join(server, "node_modules/tsx/dist"), { recursive: true });
  fs.writeFileSync(path.join(server, "node_modules/tsx/dist/loader.mjs"), "");
  fs.writeFileSync(
    path.join(server, "src/index.js"),
    `
      const fs = require("node:fs");
      const http = require("node:http");
      const path = require("node:path");
      const scenario = process.env.STAGING_TEST_SCENARIO;
      const record = (event) => fs.appendFileSync(process.env.STAGING_TEST_EVENTS, JSON.stringify(event) + "\\n");
      fs.writeFileSync(process.env.STAGING_TEST_CHILD, JSON.stringify({ pid: process.pid, db: process.env.SQLITE_PATH }));
      for (const suffix of ["", "-shm", "-wal"]) fs.writeFileSync(process.env.SQLITE_PATH + suffix, "SQLite fixture");
      const health = { storage: { data: { backend: "sqlite", durable: true }, vector: { driver: "sqlite-vec", capable: true } } };
      http.createServer((req, res) => {
        record({ type: "request", url: req.url });
        res.writeHead(200, { "content-type": "application/json" });
        if (scenario === "stalled-body" && req.url === "/api/health") {
          res.write('{"storage":');
          return;
        }
        if (scenario === "invalid-plugins" && req.url === "/api/plugins") {
          res.end("not JSON");
          return;
        }
        res.end(JSON.stringify(req.url === "/api/health" ? health : { items: [] }));
      }).listen(Number(process.env.SERVER_PORT), "127.0.0.1", () => {
        record({ type: "ready" });
        process.send({ type: "covel:ready", port: Number(process.env.SERVER_PORT) });
      });
      process.on("message", (message) => {
        if (message.type !== "covel:shutdown") return;
        record({ type: "shutdown", filesExist: ["", "-shm", "-wal"].every(suffix => fs.existsSync(process.env.SQLITE_PATH + suffix)) });
        if (scenario === "stalled-shutdown") return;
        setTimeout(() => process.exit(scenario === "failed-shutdown" ? 7 : 0), 50);
      });
    `,
  );
  const output = path.join(root, "verify.mjs");
  await build({
    entryPoints: [
      fileURLToPath(new URL("./verify-staging.mjs", import.meta.url)),
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    // Keep readiness generous, but shorten HTTP and drain deadlines. The real
    // timeout and force-kill paths still execute in the verifier subprocess.
    define: { setTimeout: "fixtureSetTimeout" },
    banner: {
      js: "const fixtureSetTimeout = (fn, ms, ...args) => setTimeout(fn, ms >= 5000 && ms < 30000 ? 1500 : ms, ...args);",
    },
    plugins: [
      {
        name: "staging-lifecycle-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^undici$/ }, () => ({
            path: pathToFileURL(require.resolve("undici")).href,
            external: true,
          }));
          builder.onResolve(
            {
              filter:
                /^(\.\/(backend-runtime|ensure-electron|packaged-main|private-config|plugin-load-check)\.mjs|\.\.\/src\/runtime-integrity\.ts)$/,
            },
            (args) => ({ path: args.path, namespace: "preflight" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "preflight" }, () => ({
            contents: `
              export const BACKEND_RUNTIME_MODE = "fixture";
              export const backendRuntimeEnvironment = env => env;
              export const backendRuntimeStagingDirectory = () => "unused";
              export const packagedElectronExecutable = () => process.execPath;
              export const ensureElectronBinary = () => process.execPath;
              export const verifyAndProbeBackendRuntime = async () => ({ node: process.versions.node, platform: process.platform, arch: process.arch });
              export const verifyRuntimeSelection = () => ({});
              export const verifyPackagedMain = () => {};
              export const verifyRuntimeFile = async () => {};
              export const assertNoPrivateConfig = () => {};
              export const assertLoadedBuiltinPluginEntries = () => {};
              export const assertNoPluginLoadErrors = () => {};
            `,
          }));
          builder.onResolve({ filter: /^node:fs$/ }, (args) => {
            if (args.importer.endsWith("verify-staging.mjs"))
              return { path: args.path, namespace: "cleanup-observer" };
          });
          builder.onLoad(
            { filter: /.*/, namespace: "cleanup-observer" },
            () => ({
              contents: `
              import fs from "node:fs";
              export default {
                ...fs,
                rmSync(file, options) {
                  const { pid } = JSON.parse(fs.readFileSync(process.env.STAGING_TEST_CHILD, "utf8"));
                  let childAlive = true;
                  try { process.kill(pid, 0); } catch (error) {
                    if (error.code !== "ESRCH") throw error;
                    childAlive = false;
                  }
                  fs.appendFileSync(process.env.STAGING_TEST_EVENTS, JSON.stringify({ type: "cleanup", file, childAlive }) + "\\n");
                  return fs.rmSync(file, options);
                },
              };
            `,
            }),
          );
        },
      },
    ],
  });

  for (const [scenario, error] of [
    ["stalled-body", /abort/i],
    ["invalid-plugins", /staged \/api\/plugins unavailable/],
    ["failed-shutdown", /staged server shutdown failed \(code=7/],
    ["stalled-shutdown", /staged server did not drain/],
    ["success", null],
  ]) {
    await t.test(scenario, async () => {
      const eventsFile = path.join(root, `${scenario}.jsonl`);
      const childFile = path.join(root, `${scenario}-child.json`);
      const verifier = spawn(
        process.execPath,
        [output, "--resources", resources],
        {
          env: {
            ...process.env,
            STAGING_TEST_SCENARIO: scenario,
            STAGING_TEST_EVENTS: eventsFile,
            STAGING_TEST_CHILD: childFile,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let logs = "";
      verifier.stdout.on("data", (data) => {
        logs += data;
      });
      verifier.stderr.on("data", (data) => {
        logs += data;
      });
      let timedOut = false;
      const watchdog = setTimeout(() => {
        timedOut = true;
        verifier.kill("SIGKILL");
        if (fs.existsSync(childFile)) {
          const { pid } = JSON.parse(fs.readFileSync(childFile, "utf8"));
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }, 15_000);
      try {
        const exit = await new Promise((resolve, reject) => {
          verifier.once("error", reject);
          verifier.once("close", (code, signal) => resolve({ code, signal }));
        });
        assert.equal(timedOut, false, logs);
        assert.deepEqual(exit, { code: error ? 1 : 0, signal: null }, logs);
        if (error) assert.match(logs, error);
        const events = fs
          .readFileSync(eventsFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(events[0].type, "ready");
        assert.ok(events.some((event) => event.type === "request"));
        const shutdowns = events.filter((event) => event.type === "shutdown");
        assert.ok(shutdowns.length > 0, logs);
        assert.ok(
          shutdowns.every((event) => event.filesExist),
          "SQLite files must remain during drain",
        );
        const cleanup = events.filter((event) => event.type === "cleanup");
        assert.equal(
          cleanup.length,
          4,
          "database, SHM, WAL, and user root must be removed",
        );
        assert.ok(
          cleanup.every((event) => !event.childAlive),
          "child must be reaped before any SQLite cleanup",
        );
        const { pid, db } = JSON.parse(fs.readFileSync(childFile, "utf8"));
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        assert.equal(fs.existsSync(path.dirname(db)), false);
      } finally {
        clearTimeout(watchdog);
        verifier.kill("SIGKILL");
        if (fs.existsSync(childFile)) {
          const { pid, db } = JSON.parse(fs.readFileSync(childFile, "utf8"));
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
          fs.rmSync(path.dirname(db), { recursive: true, force: true });
        }
      }
    });
  }
});
