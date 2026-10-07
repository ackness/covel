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
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoPrivateConfig } from "./private-config.mjs";
import {
  assertLoadedBuiltinPluginEntries,
  assertNoPluginLoadErrors,
} from "./plugin-load-check.mjs";

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const stagingDir = path.join(desktopRoot, "staging");
const resourcesArgument = process.argv.indexOf("--resources");
if (resourcesArgument !== -1 && !process.argv[resourcesArgument + 1]) {
  throw new Error("--resources requires an unpacked app Resources directory");
}
const resourcesDir =
  resourcesArgument === -1
    ? stagingDir
    : path.resolve(process.argv[resourcesArgument + 1]);
const serverStaging = path.join(resourcesDir, "server");

const noLlmToml = process.argv.includes("--no-llm-toml");
const electronNode = process.argv.includes("--electron-node");
const TIMEOUT_MS = 30_000;

function die(msg, code = 1) {
  console.error(`[smoke] ${msg}`);
  process.exit(code);
}

function resolveElectronBinaryPath() {
  let electronPackageJson;
  try {
    electronPackageJson = require.resolve("electron/package.json");
  } catch {
    return null;
  }

  const electronDir = path.dirname(electronPackageJson);
  const pathFile = path.join(electronDir, "path.txt");
  if (!fs.existsSync(pathFile)) return null;

  const relativeBinary = fs.readFileSync(pathFile, "utf-8").trim();
  const binaryPath = path.join(electronDir, "dist", relativeBinary);
  return fs.existsSync(binaryPath) ? binaryPath : null;
}

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
const tmpDb = path.join(desktopRoot, "staging", `.smoke-${port}.db`);
const tmpUserRoot = path.join(stagingDir, `.smoke-user-${port}`);
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

const electronBinary = electronNode ? resolveElectronBinaryPath() : null;
const useElectronNode = Boolean(electronBinary);
// A missing Electron binary must fail the build by default: the whole point
// of the --electron-node smoke is to load better-sqlite3's staged Node-API
// binary in the exact runtime used by the packaged sidecar. A silent host-Node
// + memory-backend downgrade would skip that compatibility check. Machines
// that genuinely cannot download the Electron binary can opt into the weaker
// smoke explicitly.
const allowHostNodeFallback = process.env.COVEL_SMOKE_HOST_NODE === "1";
const useMemoryBackend = electronNode && !electronBinary;
if (electronNode && !electronBinary) {
  if (!allowHostNodeFallback) {
    die(
      "[smoke] --electron-node requested but the Electron binary is not installed " +
        "(node_modules/electron/dist missing). Reinstall electron (pnpm install) or " +
        "set COVEL_SMOKE_HOST_NODE=1 to accept a weaker host-Node + memory-backend smoke " +
        "that does NOT exercise the staged native modules in Electron.",
    );
  }
  console.warn(
    "[smoke] COVEL_SMOKE_HOST_NODE=1 — Electron binary missing, running weaker host-Node + memory-backend smoke (native modules in Electron NOT verified).",
  );
}

// Exercise synthetic and absent config independently of the developer's paths.
const env = {
  ...process.env,
  ...(useElectronNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  SERVER_PORT: String(port),
  STORE_BACKEND: useMemoryBackend ? "memory" : "sqlite",
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
  `[smoke] spawning staged server on port ${port}` +
    (useElectronNode
      ? " (electron node)"
      : useMemoryBackend
        ? " (host node, memory backend)"
        : "") +
    (noLlmToml ? " (without llm.toml)" : ""),
);

const stderrBuf = [];
const nodeBinary = electronBinary ?? process.execPath;
// A file URL, as the desktop app passes it: an absolute Windows path is not
// a module specifier.
const child = spawn(
  nodeBinary,
  ["--import", pathToFileURL(tsxLoader).href, entry],
  {
    cwd: serverStaging,
    env,
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
  assertNoStartupPathErrors();
  assertNoPluginLoadErrors(stderrBuf);
  const pluginsResponse = await fetch(`http://127.0.0.1:${port}/api/plugins`);
  if (!pluginsResponse.ok) throw new Error("staged /api/plugins unavailable");
  assertLoadedBuiltinPluginEntries((await pluginsResponse.json()).items);
  booted = true;
  console.log("[smoke] ✓ /api/health and builtin plugin entries OK");
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
