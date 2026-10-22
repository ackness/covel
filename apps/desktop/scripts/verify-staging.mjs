/**
 * Post-staging smoke test.
 *
 * Spawns the staged server exactly the way the packaged desktop app will:
 *   <node> --import <file URL of the plugin TS loader> <staging/server/src/index.js>
 *
 * Waits for private readiness IPC, verifies health and plugin entries, then
 * requests and awaits an IPC drain. If boot fails, stderr is reported
 * so `electron-builder` never wraps a known-broken sidecar.
 *
 * Run with `--no-llm-toml` to exercise the "user has no config yet" path
 * — the server must still boot and answer /api/health via the built-in
 * default.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoPrivateConfig } from "./private-config.mjs";
import {
  assertLoadedBuiltinPluginEntries,
  assertNoPluginLoadErrors,
} from "./plugin-load-check.mjs";
import {
  BACKEND_RUNTIME_MODE,
  backendRuntimeEnvironment,
  backendRuntimeStagingDirectory,
  packagedElectronExecutable,
  probeBackendRuntime,
  verifyBackendRuntime,
  verifyRuntimeSelection,
} from "./backend-runtime.mjs";
import { ensureElectronBinary } from "./ensure-electron.mjs";
import { verifyNodeRuntimeFile } from "../src/node-runtime.ts";
import { verifyPackagedMain } from "./packaged-main.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const stagingDir = path.join(desktopRoot, "staging");
const options = { platform: process.platform, arch: process.arch };
let resourcesDir;
let noLlmToml = false;
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === "--no-llm-toml") {
    noLlmToml = true;
  } else if (["--resources", "--platform", "--arch"].includes(argument)) {
    const value = process.argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--resources") resourcesDir = path.resolve(value);
    else options[argument.slice(2)] = value;
  } else {
    throw new Error(`Unknown staging verification argument: ${argument}`);
  }
}
const packaged = resourcesDir !== undefined;
const runtimeResources = packaged
  ? resourcesDir
  : backendRuntimeStagingDirectory(desktopRoot, options);
resourcesDir ??= stagingDir;
const serverStaging = path.join(resourcesDir, "server");
const selection = verifyRuntimeSelection(
  path.join(runtimeResources, "runtime-selection.json"),
  options,
);
if (packaged) {
  verifyPackagedMain(runtimeResources, selection.mainSha256);
} else {
  await verifyNodeRuntimeFile(
    path.join(desktopRoot, "dist/main.mjs"),
    selection.mainSha256,
  );
}
const electronExecutable =
  BACKEND_RUNTIME_MODE === "electron"
    ? packaged
      ? packagedElectronExecutable(runtimeResources, options)
      : ensureElectronBinary()
    : undefined;
// Verify pinned standalone bytes before executing them. Electron versions are
// probed first, then checked with the same policy as the packaged main process.
const executable =
  electronExecutable ?? (await verifyBackendRuntime(runtimeResources, options));
// No backend module is imported until the actual executable's versions pass.
const runtime = await probeBackendRuntime(executable, options);
const nodeBinary = electronExecutable
  ? await verifyBackendRuntime(runtimeResources, {
      ...options,
      electronExecutable,
      electronVersions: runtime,
    })
  : executable;
const TIMEOUT_MS = 30_000;

function die(msg, code = 1) {
  console.error(`[smoke] ${msg}`);
  process.exit(code);
}

console.log(
  `[smoke] verified ${BACKEND_RUNTIME_MODE} Node ${runtime.node} (${runtime.platform}-${runtime.arch})`,
);

if (!fs.existsSync(serverStaging)) {
  die(
    `staging/server missing at ${serverStaging}. Run the build script first.`,
  );
}

const tsxLoader = path.join(serverStaging, "node_modules/tsx/dist/loader.mjs");
const entry = path.join(serverStaging, "src/index.js");
if (!fs.existsSync(tsxLoader)) die(`plugin TS loader missing at ${tsxLoader}`);
if (!fs.existsSync(entry)) die(`server entry missing at ${entry}`);

assertNoPrivateConfig(serverStaging);

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        s.close(() => reject(new Error("could not pick free port")));
      }
    });
    s.on("error", reject);
  });
}

const port = await findFreePort();
const tmpUserRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "covel-sidecar-smoke-"),
);
const tmpDb = path.join(tmpUserRoot, "covel.db");
const userPluginsDir = path.join(tmpUserRoot, "plugins");
const userWorldsDir = path.join(tmpUserRoot, "worlds");
const userConfigDir = path.join(tmpUserRoot, "config");
const logsDir = path.join(tmpUserRoot, "logs");
for (const dir of [userPluginsDir, userWorldsDir, userConfigDir, logsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
const smokeLlmToml = path.join(userConfigDir, "llm.toml");
if (!noLlmToml) {
  fs.writeFileSync(
    smokeLlmToml,
    '[covel.story]\nprovider = "deepseek"\nmodel = "smoke-model"\nbaseUrl = "https://example.invalid/v1"\nprotocol = "openai-chat-v1"\n',
    "utf-8",
  );
}

// Exercise synthetic and absent config independently of the developer's paths.
const env = {
  ...process.env,
  SERVER_PORT: String(port),
  STORE_BACKEND: "sqlite",
  VECTOR_BACKEND: "embedded",
  MEDIA_BACKEND: "mirror",
  SQLITE_PATH: tmpDb,
  NODE_ENV: "production",
  COVEL_DESKTOP_REST: "1",
  COVEL_DESKTOP_REST_TOKEN: `smoke-${port}`,
  COVEL_PLUGINS_DIR: path.join(serverStaging, "plugins"),
  COVEL_WORLDS_DIR: path.join(serverStaging, "worlds"),
  COVEL_USER_PLUGINS_DIR: userPluginsDir,
  COVEL_USER_WORLDS_DIR: userWorldsDir,
  COVEL_USER_CONFIG_DIR: userConfigDir,
  COVEL_HOME: tmpUserRoot,
  COVEL_LLM_TOML: smokeLlmToml,
  COVEL_LOGS_DIR: logsDir,
  STATIC_DIR: path.join(resourcesDir, "web-dist"),
};

console.log(
  `[smoke] spawning ${BACKEND_RUNTIME_MODE} backend + SQLite server on port ${port}` +
    (noLlmToml ? " (without llm.toml)" : ""),
);

const stderrBuf = [];
// A file URL, as the desktop app passes it: an absolute Windows path is not
// a module specifier.
const child = spawn(
  nodeBinary,
  ["--import", pathToFileURL(tsxLoader).href, entry],
  {
    cwd: serverStaging,
    env: backendRuntimeEnvironment(env),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  },
);

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("server readiness IPC timed out")),
    TIMEOUT_MS,
  );
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("exit", () => {
    clearTimeout(timer);
    reject(new Error("server exited before readiness"));
  });
  child.on("message", (message) => {
    if (message?.type === "covel:ready" && message.port === port) {
      clearTimeout(timer);
      resolve();
    }
  });
});

child.stdout.on("data", (data) => process.stdout.write(`[server] ${data}`));
child.stderr.on("data", (data) => {
  const text = data.toString();
  process.stderr.write(`[server:err] ${text}`);
  stderrBuf.push(text);
  // Cap retention so a chatty server doesn't balloon memory
  if (stderrBuf.length > 400) stderrBuf.shift();
});

let booted = false;
child.on("exit", (code, signal) => {
  if (!booted) {
    cleanupDb();
    const tail = stderrBuf.slice(-80).join("");
    die(
      `server exited during boot (code=${code}, signal=${signal})\n--- stderr tail ---\n${tail}`,
    );
  }
});

function cleanupDb() {
  try {
    if (fs.existsSync(tmpDb)) fs.rmSync(tmpDb, { force: true });
    for (const suffix of ["-shm", "-wal"]) {
      const p = tmpDb + suffix;
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    if (fs.existsSync(tmpUserRoot))
      fs.rmSync(tmpUserRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function assertNoStartupPathErrors() {
  const stderr = stderrBuf.join("");
  if (/\bENOENT\b|\bENOTDIR\b/.test(stderr)) {
    throw new Error(
      `server reported startup path errors\n--- stderr tail ---\n${stderrBuf.slice(-80).join("")}`,
    );
  }
}

try {
  await ready;
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (!health.ok)
    throw new Error("staged /api/health unavailable after readiness IPC");
  const status = await health.json();
  if (
    status.storage?.data?.backend !== "sqlite" ||
    !status.storage.data.durable
  ) {
    throw new Error("bundled sidecar did not open durable SQLite storage");
  }
  if (
    status.storage.vector?.driver !== "sqlite-vec" ||
    status.storage.vector.capable !== true
  ) {
    throw new Error("bundled sidecar is missing the sqlite-vec capability");
  }
  assertNoStartupPathErrors();
  assertNoPluginLoadErrors(stderrBuf);
  const pluginsResponse = await fetch(`http://127.0.0.1:${port}/api/plugins`);
  if (!pluginsResponse.ok) throw new Error("staged /api/plugins unavailable");
  assertLoadedBuiltinPluginEntries((await pluginsResponse.json()).items);
  booted = true;
  console.log(
    "[smoke] ✓ /api/health, durable SQLite, sqlite-vec and builtin plugin entries OK",
  );
} catch (err) {
  const tail = stderrBuf.slice(-80).join("");
  child.kill("SIGKILL");
  cleanupDb();
  die(
    `${err instanceof Error ? err.message : err}\n--- stderr tail ---\n${tail}`,
  );
}

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("staged server did not drain within 12s"));
  }, 12_000);
  child.once("exit", (code, signal) => {
    clearTimeout(timer);
    if (code === 0 && signal === null) resolve();
    else
      reject(
        new Error(
          `staged server shutdown failed (code=${code}, signal=${signal})`,
        ),
      );
  });
  if (noLlmToml) child.disconnect();
  else child.send({ type: "covel:shutdown" });
});
cleanupDb();
console.log(
  `[smoke] ✓ staging server is bootable and drains on ${noLlmToml ? "parent disconnect" : "shutdown IPC"}`,
);
