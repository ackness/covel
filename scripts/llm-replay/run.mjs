// Run the recorded scripted sessions under tests/llm-replay/ without calling
// a model, or record them again.
//
//   pnpm e2e:replay                    every recorded session
//   pnpm e2e:replay lantern-barrow     one of them
//   pnpm e2e:replay --record --upstream https://api.deepseek.com lantern-barrow
//
// For each session this starts the replay proxy (replay-proxy.mjs), a test
// server of its own (a new SQLite database, its own home directory, the
// session's random seed, UTC) and `scripts/e2e-plugin-verify.ts` against it,
// then stops both. Nothing from `.env`, `~/.covel` or the shell's `COVEL_*`
// variables reaches the server: a value there could change what the session
// sends to the model.
//
// replay: every request must be in `recording/`; the run fails otherwise.
// record: a request in `recording/` is answered from it, any other goes to
//         `--upstream` (the endpoint's origin, without `/v1`) and is recorded.
//         The key comes from the environment or `.env.llm`, under the name
//         of the provider in the session's `llm.toml`. When the session ran
//         to its end, a recorded answer that no request used is removed.
//
// `--verbose` prints the session's output as it runs. Logs, the server log
// and the keyed requests (for `pnpm llm:replay:diff`) are written to
// debugs/llm-replay/<session>/.
//
// Docs: docs/guide/e2e-plugin-verify.md
import { createServer } from "node:net";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { spawnCommand } from "../lib/command-shim.mjs";
import { terminateProcessTree } from "../dev-supervisor.mjs";
import {
  recordedHashes,
  startReplayProxy,
  tidyFixtures,
} from "./replay-proxy.mjs";
import {
  apiKeyName,
  listSessions,
  pointAtProxy,
  readScenario,
} from "./sessions.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const SESSIONS = join(ROOT, "tests/llm-replay");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    record: { type: "boolean", default: false },
    upstream: { type: "string" },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
const usage = `usage: pnpm e2e:replay [session ...] [--verbose]
       pnpm e2e:replay --record --upstream <origin> [session ...]
sessions: ${listSessions(SESSIONS).join(", ") || "(none)"}`;
if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (values.record !== Boolean(values.upstream)) {
  console.error(`--record and --upstream go together\n${usage}`);
  process.exit(2);
}
const MODE = values.record ? "record" : "replay";

// Server settings that a developer's shell may hold and that would change
// what the test server does or where it writes.
const SERVER_SETTINGS = new Set([
  "SERVER_PORT",
  "NODE_ENV",
  "SERVE_STATIC",
  "STATIC_DIR",
  "DEPLOYMENT_TIER",
  "CORS_ORIGIN",
  "ENABLE_DEBUG_PAGE",
  "RATE_LIMIT_RPM",
  "TRUSTED_PROXY_IPS",
  "STORE_BACKEND",
  "SQLITE_PATH",
  "DATABASE_URL",
  "MEDIA_BACKEND",
  "MEDIA_ROOT",
  "VECTOR_BACKEND",
  "LIVE_LLM_ENABLED",
  "TZ",
]);
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !SERVER_SETTINGS.has(key) &&
        !/^(COVEL_|E2E_|POSTGRES_)/.test(key) &&
        !key.endsWith("_API_KEY"),
    ),
  );

const providerKeys = (providers) => {
  if (MODE === "replay")
    // The server sends a key with every request; the proxy does not read it.
    return Object.fromEntries(providers.map((p) => [apiKeyName(p), "replay"]));
  const envFile = join(ROOT, ".env.llm");
  const fromFile = existsSync(envFile)
    ? parseEnv(readFileSync(envFile, "utf8"))
    : {};
  const keys = {};
  for (const provider of providers) {
    const name = apiKeyName(provider);
    const key = process.env[name] || fromFile[name];
    if (!key)
      throw new Error(`recording needs ${name} in the environment or .env.llm`);
    keys[name] = key;
  }
  return keys;
};

const freePort = () =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

const waitForHealth = async (url, child, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`the test server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  throw new Error(`the test server did not answer ${url} in ${timeoutMs} ms`);
};

const exited = (child) =>
  new Promise((done) => {
    if (child.exitCode !== null) done(child.exitCode);
    else child.once("exit", (code) => done(code ?? 1));
  });

const tail = (text, lines = 40) => text.split("\n").slice(-lines).join("\n");

const cleanups = [];
const cleanUp = async () => {
  while (cleanups.length > 0)
    await cleanups
      .pop()()
      .catch(() => {});
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanUp().finally(() => process.exit(130));
  });

const runSession = async (name) => {
  const started = Date.now();
  const scenario = readScenario(SESSIONS, name);
  const recording = join(SESSIONS, name, "recording");
  const out = join(ROOT, "debugs/llm-replay", name);
  const recorded = recordedHashes(recording);
  if (MODE === "replay" && recorded.size === 0)
    return {
      ok: false,
      line: `not recorded yet: pnpm e2e:replay --record --upstream <origin> ${name}`,
    };

  const requestsDir = join(out, `${MODE}.requests`);
  rmSync(requestsDir, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "covel-replay-"));
  cleanups.push(async () => rmSync(work, { recursive: true, force: true }));
  const home = join(work, "home");
  for (const dir of ["worlds", "plugins"])
    mkdirSync(join(home, dir), { recursive: true });

  const proxy = await startReplayProxy({
    mode: MODE,
    fixtures: recording,
    upstream: values.upstream,
    requestsDir,
    port: 0,
    logLevel: values.verbose ? "warn" : "error",
  });
  let proxyStopped;
  const stopProxy = () => (proxyStopped ??= proxy.stop());
  cleanups.push(stopProxy);

  const toml = pointAtProxy(
    readFileSync(join(SESSIONS, name, "llm.toml"), "utf8"),
    proxy.url,
  );
  writeFileSync(join(work, "llm.toml"), toml.text);
  const port = await freePort();
  const env = cleanEnv();
  const serverLog = createWriteStream(join(out, `${MODE}-server.log`));
  const server = spawnCommand(
    "pnpm",
    [
      "exec",
      "tsx",
      "--import=../../scripts/ensure-plugin-sdk.mjs",
      "src/index.ts",
    ],
    {
      cwd: join(ROOT, "apps/server"),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        ...providerKeys(toml.providers),
        SERVER_PORT: String(port),
        STORE_BACKEND: "sqlite",
        SQLITE_PATH: join(work, "covel.db"),
        COVEL_HOME: home,
        COVEL_USER_WORLDS_DIR: join(home, "worlds"),
        COVEL_USER_PLUGINS_DIR: join(home, "plugins"),
        COVEL_LOGS_DIR: join(work, "logs"),
        COVEL_SERVER_LOG_FILE: "",
        COVEL_LLM_TOML: join(work, "llm.toml"),
        COVEL_RANDOM_SEED: scenario.seed,
        TZ: "UTC",
      },
    },
  );
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });
  let serverStopped;
  const stopServer = () =>
    (serverStopped ??= terminateProcessTree(server.pid).then(() =>
      exited(server),
    ));
  cleanups.push(stopServer);

  const api = `http://127.0.0.1:${port}/api`;
  await waitForHealth(`${api}/health`, server).catch((error) => {
    throw new Error(
      `${error.message}; see debugs/llm-replay/${name}/${MODE}-server.log`,
    );
  });

  const verify = spawnCommand(
    "pnpm",
    [
      "exec",
      "tsx",
      "scripts/e2e-plugin-verify.ts",
      "--server",
      api,
      "--world",
      scenario.world,
      "--turns",
      String(scenario.turns),
      "--locale",
      scenario.locale,
      "--session-id",
      scenario.sessionId,
      "--log-dir",
      join(out, `${MODE}-logs`),
      ...scenario.args,
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", values.verbose ? "inherit" : "pipe", "inherit"],
      env,
    },
  );
  let output = "";
  verify.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  const code = await exited(verify);
  await stopServer();
  serverLog.end();
  const stats = await stopProxy();

  const requested = proxy.requested();
  const missing = [...requested].filter((hash) => !recorded.has(hash));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const verdict = code === 0 ? "PASS" : code === 1 ? "FAIL" : "ERROR";
  if (code !== 0 && !values.verbose) console.log(tail(output));

  if (MODE === "replay")
    return {
      ok: code === 0 && missing.length === 0,
      line:
        missing.length === 0
          ? `${verdict} in ${seconds}s, ${stats.chatRequests} model calls, all answered from the recording`
          : `${verdict} in ${seconds}s, ${stats.chatRequests} model calls, ${missing.length} of ${requested.size} distinct requests not in the recording: record the session again (--record), or compare debugs/llm-replay/${name}/record.requests with replay.requests (pnpm llm:replay:diff) when both are on this machine`,
    };
  // A session that stopped early sent only part of its requests: keep the
  // answers it did not reach.
  const { kept, removed } = tidyFixtures(
    recording,
    code === 0 || code === 1 ? requested : undefined,
  );
  return {
    ok: code === 0,
    line: `${verdict} in ${seconds}s, ${stats.chatRequests} model calls, ${missing.length} recorded now; recording/ holds ${kept} answers${removed > 0 ? `, ${removed} unused removed` : ""}`,
  };
};

const names = positionals.length > 0 ? positionals : listSessions(SESSIONS);
if (names.length === 0) {
  console.log(`no recorded sessions under ${SESSIONS}`);
  process.exit(0);
}
let failed = 0;
for (const name of names) {
  console.log(`e2e:replay ${MODE} ${name} ...`);
  try {
    const result = await runSession(name);
    if (!result.ok) failed += 1;
    console.log(`${name}: ${result.line}`);
  } catch (error) {
    failed += 1;
    console.log(`${name}: ${error instanceof Error ? error.message : error}`);
  } finally {
    await cleanUp();
  }
}
console.log("logs: debugs/llm-replay/");
process.exit(failed > 0 ? 1 : 0);
