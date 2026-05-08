/**
 * Covel Desktop — Electron main process.
 *
 * Architecture: sidecar pattern.
 *   1. Resolve paths, ensure userData directories exist
 *   2. Find a free port (detecting conflicts)
 *   3. Show splash screen with loading animation
 *   4. Spawn the Hono API server as a child process
 *   5. Wait for /api/health, with progress updates and retry on failure
 *   6. Navigate to the app URL; bind menu and IPC handlers
 *   7. Monitor the server and auto-restart on unexpected exit
 *   8. Clean up on quit
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

import {
  ensureUserPaths,
  isDev,
  resolvePreloadScript,
  resolveProjectRoot,
  resolveServerEntry,
  resolveTsx,
  resolveWindowIconPath,
  userServerPortFile,
  writeDataRoot,
} from "./paths.js";
import { normalizeProviderKeyMap, toApiKeyEnvMap } from "./provider-keys.js";

// Name matters on macOS (app menu "About …") and Windows (DPAPI service
// label if we ever re-introduce secure-storage). Derived default would be
// "@covel/desktop" from package.json — override to the friendly product name.
app.setName("Covel");
import {
  attachWindowStateTracking,
  resolveInitialWindowOptions,
} from "./window-state.js";
import {
  importAsset,
  type ImportKind,
  type ImportResult,
} from "./import-assets.js";
import { initAutoUpdater } from "./auto-updater.js";

// ── Persistent logging ──────────────────────────────────────────
//
// Two parallel rolling channels live under <logsDir>/:
//   - desktop.log : Electron shell events (lifecycle, window, IPC, sidecar
//                   supervisor decisions). NDJSON, one record per line.
//   - server.log  : Raw stdout/stderr from the sidecar child process,
//                   wrapped line-by-line into NDJSON. Sidecar bootstrap
//                   logs and Hono request logs land here. Business
//                   trace events stay in the DB (`trace_events`) and
//                   are surfaced via the `/debug` UI / export — they
//                   are intentionally NOT mirrored to file.
//
// Each channel rotates independently by size: file → file.1 → … → file.N.
//
// Older releases wrote everything to a single `electron.log`; the file is
// left in place to age out via rotation. New writes go to `desktop.log`.

type LogLevel = "info" | "warn" | "error";

interface LogChannel {
  readonly filePath: string;
  stream: fs.WriteStream | null;
  bytesWritten: number;
}

let desktopChannel: LogChannel | null = null;
let serverChannel: LogChannel | null = null;
let logMaxBytes = 10 * 1024 * 1024; // default 10MB per file
let logMaxFiles = 10;

function openChannel(filePath: string): LogChannel {
  let bytesWritten = 0;
  try {
    bytesWritten = fs.statSync(filePath).size;
  } catch {
    bytesWritten = 0;
  }
  return {
    filePath,
    stream: fs.createWriteStream(filePath, { flags: "a" }),
    bytesWritten,
  };
}

function rotateChannel(ch: LogChannel): void {
  try {
    ch.stream?.end();
    for (let i = logMaxFiles - 1; i >= 1; i--) {
      const older = `${ch.filePath}.${i}`;
      const newer = i === 1 ? ch.filePath : `${ch.filePath}.${i - 1}`;
      if (fs.existsSync(newer)) {
        if (i === logMaxFiles - 1 && fs.existsSync(older)) {
          fs.unlinkSync(older);
        }
        try {
          fs.renameSync(newer, older);
        } catch {
          // rename across directories shouldn't happen here; ignore
        }
      }
    }
    ch.stream = fs.createWriteStream(ch.filePath, { flags: "a" });
    ch.bytesWritten = 0;
  } catch (err) {
    console.error(`[desktop] log rotation failed for ${ch.filePath}:`, err);
  }
}

function writeChannel(ch: LogChannel | null, ndjsonLine: string): void {
  if (!ch || !ch.stream) return;
  const buf = ndjsonLine + "\n";
  const byteLen = Buffer.byteLength(buf, "utf8");
  if (ch.bytesWritten + byteLen > logMaxBytes) {
    rotateChannel(ch);
  }
  ch.stream?.write(buf);
  ch.bytesWritten += byteLen;
}

function initPersistentLog(
  logsDir: string,
  rotation: { maxSizeMb: number; maxFiles: number },
): void {
  try {
    logMaxBytes = Math.max(1, rotation.maxSizeMb) * 1024 * 1024;
    logMaxFiles = Math.max(1, rotation.maxFiles);
    desktopChannel = openChannel(path.join(logsDir, "desktop.log"));
    serverChannel = openChannel(path.join(logsDir, "server.log"));
    writeLog("info", `--- Covel desktop start (v${app.getVersion()}) ---`);
  } catch (err) {
    console.error("[desktop] Could not open log files:", err);
  }
}

/**
 * Strip CSI / SGR escape sequences before persisting a line. The terminal
 * forwards (`process.stdout.write` / `console.*`) keep the original
 * coloured text — only the file copy is sanitised so `jq` / log viewers
 * see a clean `msg` field.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B]\[[0-?]*[ -/]*[@-~]/g;
function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

/**
 * Render an NDJSON line. Each record carries a stable shape so downstream
 * `jq` / log viewers can filter by level/source without parsing free text.
 */
function ndjsonLine(
  level: LogLevel,
  source: "desktop" | "server" | "server.err",
  msg: string,
): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    source,
    msg: stripAnsi(msg),
  });
}

function writeLog(level: LogLevel, ...parts: unknown[]): void {
  const msg = parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ");
  // Pretty for stdout / dev terminal — keeps `pnpm dev:electron` readable.
  const pretty = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  switch (level) {
    case "error":
      console.error(pretty);
      break;
    case "warn":
      console.warn(pretty);
      break;
    default:
      console.log(pretty);
  }
  writeChannel(desktopChannel, ndjsonLine(level, "desktop", msg));
}

/**
 * Persist a sidecar stdout/stderr line to `server.log` only.
 * The desktop channel intentionally stays clean of sidecar chatter.
 */
function writeServerStreamLine(
  origin: "stdout" | "stderr",
  line: string,
): void {
  if (!line || !line.trim()) return;
  const level: LogLevel = origin === "stderr" ? "error" : "info";
  const source = origin === "stderr" ? "server.err" : "server";
  writeChannel(serverChannel, ndjsonLine(level, source, line));
}

// ── Startup error classification ───────────────────────────────

interface DiagnosedError {
  title: string;
  detail: string;
  hint?: string;
}

function diagnoseStartupError(err: unknown): DiagnosedError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/EADDRINUSE|address already in use/i.test(msg)) {
    return {
      title: "Port conflict",
      detail: msg,
      hint: "Another process is using the required port. Close other Covel instances or restart your computer.",
    };
  }
  if (/EACCES|permission denied/i.test(msg)) {
    return {
      title: "Permission denied",
      detail: msg,
      hint: "Covel could not access a required directory. Check that the app has permission to write to its data folder.",
    };
  }
  if (/did not start within|timeout/i.test(msg)) {
    return {
      title: "Server timed out",
      detail: msg,
      hint: "The backend took too long to boot. Check the logs. A missing llm.toml or slow disk can cause this.",
    };
  }
  if (/ENOENT/i.test(msg)) {
    return {
      title: "Missing file",
      detail: msg,
      hint: "A required bundled file is missing. The installation may be corrupt — reinstall the app.",
    };
  }
  return { title: "Startup failed", detail: msg };
}

// ── Network helpers ─────────────────────────────────────────────

/** Check whether a TCP port is currently occupied on 127.0.0.1. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => {
      s.close(() => resolve(true));
    });
    s.listen(port, "127.0.0.1");
  });
}

/** Find a random free port. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not find free port")));
      }
    });
    server.on("error", reject);
  });
}

/** Poll a URL until it returns 200 or timeout. */
async function waitForServer(
  url: string,
  timeoutMs = 30_000,
  initialIntervalMs = 150,
  onProgress?: (elapsed: number, total: number) => void,
): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let interval = initialIntervalMs;
  while (Date.now() < deadline) {
    onProgress?.(Date.now() - start, timeoutMs);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
    // Back off: start with rapid polls for quick boot, then slow to 1s
    interval = Math.min(1000, Math.round(interval * 1.35));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

// ── Splash screen ──────────────────────────────────────────────

/** Collected server stderr lines for the "View Logs" feature. */
const serverStderrLines: string[] = [];
const MAX_STDERR_BUFFER = 1000;

function captureStderrLine(line: string): void {
  if (!line.trim()) return;
  serverStderrLines.push(line);
  if (serverStderrLines.length > MAX_STDERR_BUFFER) {
    serverStderrLines.shift();
  }
  // Sidecar stderr → server.log (NDJSON). desktop.log stays uncluttered.
  writeServerStreamLine("stderr", line);
}

function buildSplashHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Covel</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #09090b; color: #fafafa;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    overflow: hidden; -webkit-app-region: drag; user-select: none;
  }
  @media (prefers-color-scheme: light) {
    body { background: #fafafa; color: #09090b; }
    .brand { color: #18181b !important; }
    #status { color: #52525b !important; }
    .btn { background: #f4f4f5 !important; border-color: #e4e4e7 !important; color: #18181b !important; }
    .btn:hover { background: #e4e4e7 !important; }
    #log-viewer { background: #f4f4f5 !important; border-color: #e4e4e7 !important; }
    #log-content { color: #52525b !important; }
  }
  .brand { font-size: 42px; font-weight: 700; letter-spacing: 0.08em; color: #e4e4e7;
    margin-bottom: 48px; opacity: 0; animation: fade-in 0.6s ease-out 0.15s forwards; }
  .spinner-wrap { position: relative; width: 56px; height: 56px; margin-bottom: 40px;
    opacity: 0; animation: fade-in 0.6s ease-out 0.35s forwards; }
  .ring { position: absolute; inset: 0; border-radius: 50%; border: 2px solid transparent; }
  .ring-1 { border-top-color: #a1a1aa; animation: spin 1.1s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite; }
  .ring-2 { inset: 6px; border-right-color: #71717a; animation: spin 1.6s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite reverse; }
  .ring-3 { inset: 12px; border-bottom-color: #52525b; animation: spin 2.2s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite; }
  .dot { position: absolute; width: 4px; height: 4px; background: #d4d4d8; border-radius: 50%;
    top: 50%; left: 50%; transform: translate(-50%, -50%); animation: pulse 2s ease-in-out infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; transform: translate(-50%, -50%) scale(1); }
    50% { opacity: 1; transform: translate(-50%, -50%) scale(1.6); }
  }
  @keyframes fade-in { to { opacity: 1; } }
  #status { font-size: 13px; color: #a1a1aa; letter-spacing: 0.04em; min-height: 20px;
    opacity: 0; animation: fade-in 0.6s ease-out 0.5s forwards; transition: color 0.3s ease; }
  .error-wrap { display: none; flex-direction: column; align-items: center; gap: 10px;
    margin-top: 24px; opacity: 0; animation: fade-in 0.4s ease-out forwards; }
  .error-wrap.visible { display: flex; }
  .error-title { font-size: 14px; font-weight: 600; color: #f87171; }
  .error-msg { font-size: 12px; color: #a1a1aa; text-align: center; max-width: 460px; line-height: 1.5; }
  .error-hint { font-size: 12px; color: #d4d4d8; text-align: center; max-width: 460px; line-height: 1.5; margin-top: 4px; }
  .btn-row { display: flex; gap: 10px; -webkit-app-region: no-drag; margin-top: 6px; flex-wrap: wrap; justify-content: center; }
  .btn { padding: 7px 18px; border-radius: 6px; border: 1px solid #27272a; background: #18181b;
    color: #d4d4d8; font-size: 12px; font-weight: 500; cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease; letter-spacing: 0.02em; }
  .btn:hover { background: #27272a; border-color: #3f3f46; }
  .btn-primary { background: #27272a; border-color: #3f3f46; }
  .btn-primary:hover { background: #3f3f46; border-color: #52525b; }
  #log-viewer { display: none; margin-top: 16px; padding: 12px 16px; background: #18181b;
    border: 1px solid #27272a; border-radius: 8px; max-width: 560px; max-height: 200px;
    overflow-y: auto; width: 90vw; -webkit-app-region: no-drag; }
  #log-viewer.visible { display: block; }
  #log-content { font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 11px; color: #a1a1aa; white-space: pre-wrap; word-break: break-all; line-height: 1.6; }
</style>
</head>
<body>
  <div class="brand">COVEL</div>
  <div class="spinner-wrap" id="spinner">
    <div class="ring ring-1"></div><div class="ring ring-2"></div>
    <div class="ring ring-3"></div><div class="dot"></div>
  </div>
  <div id="status">Initializing\u2026</div>

  <div class="error-wrap" id="error-wrap">
    <div class="error-title" id="error-title">Startup failed</div>
    <div class="error-msg" id="error-msg"></div>
    <div class="error-hint" id="error-hint"></div>
    <div class="btn-row">
      <button class="btn btn-primary" id="btn-retry">Retry</button>
      <button class="btn" id="btn-logs">View Logs</button>
      <button class="btn" id="btn-open-logs">Open Logs Folder</button>
      <button class="btn" id="btn-open-data">Open Data Folder</button>
    </div>
  </div>

  <div id="log-viewer"><div id="log-content"></div></div>

  <script>
    const ipc = window.covelIpc;
    document.getElementById('btn-retry').addEventListener('click', () => ipc.invoke('covel:retry-startup'));
    document.getElementById('btn-logs').addEventListener('click', () => {
      document.getElementById('log-viewer').classList.toggle('visible');
    });
    document.getElementById('btn-open-logs').addEventListener('click', () => ipc.invoke('covel:open-logs-dir'));
    document.getElementById('btn-open-data').addEventListener('click', () => ipc.invoke('covel:open-data-dir'));

    ipc.on('covel:startup:progress', (payload) => {
      document.getElementById('status').textContent = payload && payload.label ? payload.label : 'Loading\u2026';
    });

    ipc.on('covel:startup:error', (payload) => {
      document.getElementById('spinner').style.display = 'none';
      document.getElementById('status').style.color = '#71717a';
      document.getElementById('status').textContent = 'Startup failed';
      document.getElementById('error-title').textContent = payload.title || 'Startup failed';
      document.getElementById('error-msg').textContent = payload.detail || '';
      document.getElementById('error-hint').textContent = payload.hint || '';
      document.getElementById('log-content').textContent = payload.logs || '';
      document.getElementById('error-wrap').classList.add('visible');
    });
  </script>
</body>
</html>`;
}

// ── Env file loader ─────────────────────────────────────────────

function loadEnvFiles(baseDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [".env", ".env.llm"]) {
    const filePath = path.join(baseDir, name);
    if (!fs.existsSync(filePath)) continue;
    parseEnvFileInto(filePath, result);
  }
  return result;
}

/**
 * Read `~/.covel/keys.env` into a provider-id keyed record for the renderer.
 * Missing file is fine (fresh install). Legacy bare keys like `deepseek=...`
 * are folded into the same shape as `DEEPSEEK_API_KEY=...`.
 */
function loadKeysEnv(keysFile: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(keysFile)) return result;
  parseEnvFileInto(keysFile, result);
  return normalizeProviderKeyMap(result);
}

function loadKeysEnvForChild(keysFile: string): Record<string, string> {
  return toApiKeyEnvMap(loadKeysEnv(keysFile));
}

function saveKeysEnv(keysFile: string, keys: Record<string, string>): void {
  const envKeys = toApiKeyEnvMap(keys);
  const body =
    `# Covel provider API keys. One KEY=VALUE per line.\n` +
    `# Example:\n#   DEEPSEEK_API_KEY=sk-xxx\n#   OPENAI_API_KEY=sk-xxx\n\n` +
    Object.entries(envKeys)
      .filter(([k, v]) => k && typeof v === "string" && v.trim())
      .map(([k, v]) => `${k}=${v.trim()}`)
      .join("\n") +
    "\n";
  fs.mkdirSync(path.dirname(keysFile), { recursive: true });
  fs.writeFileSync(keysFile, body, { mode: 0o600 });
}

async function requestSidecarConfig<T>(
  pathName: string,
  init?: RequestInit,
): Promise<T> {
  if (serverPort <= 0) throw new Error("sidecar not ready");
  const res = await fetch(`http://127.0.0.1:${serverPort}${pathName}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${desktopRestToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(`sidecar ${pathName} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

async function getSettingsViaSidecar(): Promise<Record<string, unknown>> {
  const bundle = await requestSidecarConfig<{
    entries?: Record<string, unknown>;
  }>("/api/config/settings");
  return bundle.entries ?? {};
}

async function saveSettingsViaSidecar(
  entries: Record<string, unknown>,
): Promise<void> {
  await requestSidecarConfig<{ ok?: boolean }>("/api/config/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
}

async function saveKeysViaSidecar(keys: Record<string, string>): Promise<void> {
  await requestSidecarConfig<{ ok?: boolean }>("/api/config/keys", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(keys),
  });
}

function parseEnvFileInto(
  filePath: string,
  into: Record<string, string>,
): void {
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    into[key] = val;
  }
}

// ── Server lifecycle ────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;
let serverPort = 0;
let serverStartedAt = 0;
let manualStop = false;
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 3;

// Per-launch bearer token for privileged /api/config/* writes. Generated
// once at app startup and reused across sidecar restarts so the renderer's
// stored token stays valid through "save data root → restart sidecar".
// Regenerated only on a full app relaunch.
const desktopRestToken = randomUUID();

function broadcastProgress(label: string): void {
  writeLog("info", `progress: ${label}`);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("covel:startup:progress", { label });
    }
  }
}

function broadcastStartupError(diag: DiagnosedError, logs: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("covel:startup:error", { ...diag, logs });
    }
  }
}

async function startServer(
  paths: ReturnType<typeof ensureUserPaths>,
): Promise<number> {
  // Check configured port availability before committing to it
  const port = await findFreePort();
  if (!(await isPortFree(port))) {
    throw new Error(`EADDRINUSE: port ${port} became unavailable`);
  }
  serverPort = port;
  fs.writeFileSync(userServerPortFile(), String(port), "utf-8");

  const serverEntry = resolveServerEntry();
  const projectRoot = resolveProjectRoot();
  const tsxPath = resolveTsx();

  const envOverrides = loadEnvFiles(projectRoot);
  const keysEnv = loadKeysEnvForChild(paths.userKeysEnvPath);

  // Data dir lives at <dataRoot>/; ensure the db's parent (and logs dir) exist.
  fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...envOverrides,
    ...keysEnv,
    SERVER_PORT: String(port),
    STORE_BACKEND: envOverrides.STORE_BACKEND ?? "sqlite",
    SQLITE_PATH: paths.dbPath,
    NODE_ENV: isDev ? "development" : "production",
    ...(isDev ? {} : { SERVE_STATIC: "true" }),
    COVEL_HOME: paths.covelHome,
    COVEL_DATA_ROOT: paths.dataRoot,
    COVEL_DESKTOP_REST: "1",
    COVEL_DESKTOP_REST_TOKEN: desktopRestToken,
    COVEL_PLUGINS_DIR: paths.pluginsDirs[0] ?? "",
    COVEL_WORLDS_DIR: paths.worldsDirs[0] ?? "",
    COVEL_USER_WORLDS_DIR: paths.userWorldsDir,
    COVEL_USER_PLUGINS_DIR: paths.userPluginsDir,
    COVEL_USER_CONFIG_DIR: paths.covelHome,
    COVEL_LLM_TOML: paths.effectiveLlmToml,
    COVEL_LOGS_DIR: paths.logsDir,
    COVEL_LOG_MAX_SIZE_MB: String(paths.logRotation.maxSizeMb),
    COVEL_LOG_MAX_FILES: String(paths.logRotation.maxFiles),
    COVEL_MEMORY_V1: "1",
  };

  if (!isDev) {
    env.STATIC_DIR = path.join(process.resourcesPath!, "web-dist");
  }

  writeLog("info", `Starting server on port ${port}`);
  writeLog("info", `tsx: ${tsxPath}`);
  writeLog("info", `entry: ${serverEntry}`);
  writeLog("info", `cwd: ${projectRoot}`);
  writeLog("info", `db: ${paths.dbPath}`);
  writeLog("info", `llm.toml: ${paths.effectiveLlmToml}`);

  const spawnEnv: Record<string, string> = { ...env };
  const nodeBin = isDev ? "node" : process.execPath;
  if (!isDev) {
    spawnEnv.ELECTRON_RUN_AS_NODE = "1";
  }
  writeLog("info", `node: ${nodeBin}`);

  manualStop = false;
  serverProcess = spawn(nodeBin, [tsxPath, serverEntry], {
    cwd: projectRoot,
    env: spawnEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverStartedAt = Date.now();

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    // Forward to the desktop console for live observability; persist
    // line-by-line as NDJSON to server.log (no leak into desktop.log).
    process.stdout.write(`[server] ${text}`);
    for (const line of text.split("\n")) writeServerStreamLine("stdout", line);
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    process.stderr.write(`[server:err] ${text}`);
    for (const line of text.split("\n")) captureStderrLine(line);
  });

  serverProcess.on("exit", (code, signal) => {
    const uptime = Date.now() - serverStartedAt;
    writeLog(
      "warn",
      `Server exited (code=${code}, signal=${signal}, uptime=${uptime}ms)`,
    );
    serverProcess = null;

    // Only auto-restart on unexpected exit after a successful boot.
    if (manualStop) return;
    if (uptime < 2000) {
      // Crashed during boot — let the outer retry loop handle it.
      return;
    }
    scheduleServerRestart(paths);
  });

  // Wait for health check with progress updates
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  writeLog("info", `Waiting for ${healthUrl}`);
  broadcastProgress("Starting server\u2026");

  const PROGRESS_STEPS: Array<{ threshold: number; label: string }> = [
    { threshold: 0, label: "Starting server\u2026" },
    { threshold: 1_500, label: "Loading plugins\u2026" },
    { threshold: 6_000, label: "Initializing database\u2026" },
    { threshold: 15_000, label: "Almost ready\u2026" },
  ];

  await waitForServer(healthUrl, 30_000, 150, (elapsed) => {
    let currentLabel = PROGRESS_STEPS[0].label;
    for (const step of PROGRESS_STEPS) {
      if (elapsed >= step.threshold) currentLabel = step.label;
    }
    broadcastProgress(currentLabel);
  });

  broadcastProgress("Ready!");
  writeLog("info", `Server ready on port ${port}`);
  restartAttempts = 0;

  startHealthHeartbeat(healthUrl);

  return port;
}

// ── Server auto-restart ─────────────────────────────────────────

let restartTimer: NodeJS.Timeout | null = null;

function scheduleServerRestart(
  paths: ReturnType<typeof ensureUserPaths>,
): void {
  if (restartTimer) return;
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    writeLog(
      "error",
      `Server exceeded ${MAX_RESTART_ATTEMPTS} restart attempts — giving up`,
    );
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("covel:server:status", {
        state: "down",
        attempts: restartAttempts,
      });
    }
    return;
  }
  const delay = Math.min(15_000, 1000 * 2 ** restartAttempts);
  restartAttempts += 1;
  writeLog(
    "warn",
    `Scheduling server restart #${restartAttempts} in ${delay}ms`,
  );
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("covel:server:status", {
      state: "restarting",
      attempts: restartAttempts,
      delay,
    });
  }
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    try {
      await startServer(paths);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("covel:server:status", {
          state: "up",
          attempts: restartAttempts,
        });
      }
    } catch (err) {
      writeLog("error", "Restart failed:", err);
      scheduleServerRestart(paths);
    }
  }, delay);
}

// ── Health heartbeat ────────────────────────────────────────────

let heartbeatTimer: NodeJS.Timeout | null = null;
let lastHealthOk = true;

function startHealthHeartbeat(healthUrl: string): void {
  stopHealthHeartbeat();
  heartbeatTimer = setInterval(async () => {
    try {
      const res = await fetch(healthUrl);
      const ok = res.ok;
      if (ok !== lastHealthOk) {
        lastHealthOk = ok;
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("covel:server:status", {
            state: ok ? "up" : "degraded",
          });
        }
      }
    } catch {
      if (lastHealthOk) {
        lastHealthOk = false;
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("covel:server:status", { state: "down" });
        }
      }
    }
  }, 10_000);
}

function stopHealthHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Graceful shutdown.
 *
 * Returns a promise that resolves once the child process has actually exited
 * (or 5 s has passed and SIGKILL has been sent). The previous implementation
 * fire-and-forgot SIGTERM, then immediately set `serverProcess = null`,
 * which let `startServer()` race the still-alive sidecar for the SQLite
 * file, listening port, and plugin file handles.
 *
 * Concurrent calls share the same in-flight promise — the second restart
 * click while shutdown is mid-flight does not double-send signals.
 */
let pendingStop: Promise<void> | null = null;

function stopServer(): Promise<void> {
  if (pendingStop) return pendingStop;

  manualStop = true;
  stopHealthHeartbeat();
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = serverProcess;
  if (!child) {
    pendingStop = Promise.resolve();
    return pendingStop;
  }

  pendingStop = new Promise<void>((resolveStop) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      // Only clear `serverProcess` if it's still pointing at the child we
      // just stopped. Defensive: in pathological races a new spawn could
      // have already replaced it.
      if (serverProcess === child) serverProcess = null;
      resolveStop();
    };

    child.once("exit", finish);
    child.once("error", finish);

    writeLog("info", "Stopping server (SIGTERM)");
    try {
      child.kill("SIGTERM");
    } catch (err) {
      writeLog("warn", "SIGTERM threw — assuming child already gone:", err);
      finish();
      return;
    }

    const killTimer = setTimeout(() => {
      if (resolved) return;
      writeLog("warn", "Server did not exit in 5s — sending SIGKILL");
      try {
        child.kill("SIGKILL");
      } catch (err) {
        writeLog("warn", "SIGKILL threw:", err);
        finish();
      }
    }, 5000);
  }).finally(() => {
    pendingStop = null;
  });

  return pendingStop;
}

// ── IPC handlers ────────────────────────────────────────────────

type RetrySignal = () => void;
let pendingRetrySignal: RetrySignal | null = null;

function registerIpcHandlers(paths: ReturnType<typeof ensureUserPaths>): void {
  ipcMain.handle("covel:get-info", async () => ({
    version: app.getVersion(),
    platform: process.platform,
    isDev,
    covelHome: paths.covelHome,
    dataRoot: paths.dataRoot,
    logsDir: paths.logsDir,
    dbPath: paths.dbPath,
    configTomlPath: paths.configTomlPath,
    llmTomlPath: paths.userLlmTomlPath,
    keysEnvPath: paths.userKeysEnvPath,
    serverPort,
    // The renderer attaches `Authorization: Bearer <restToken>` on
    // privileged calls (PUT /api/config/{keys,settings,data-root},
    // POST /api/config/open-folder). The sidecar enforces it via
    // COVEL_DESKTOP_REST_TOKEN.
    restToken: desktopRestToken,
  }));

  ipcMain.handle("covel:retry-startup", () => {
    if (pendingRetrySignal) {
      const fn = pendingRetrySignal;
      pendingRetrySignal = null;
      fn();
    }
  });

  ipcMain.handle("covel:open-logs-dir", async () => {
    await shell.openPath(paths.logsDir);
  });

  ipcMain.handle("covel:open-config-dir", async () => {
    await shell.openPath(paths.covelHome);
  });

  ipcMain.handle("covel:open-data-dir", async () => {
    await shell.openPath(paths.dataRoot);
  });

  ipcMain.handle("covel:restart-server", async (_event: IpcMainInvokeEvent) => {
    writeLog("info", "User requested server restart via IPC");
    try {
      await stopServer();
      restartAttempts = 0;
      await startServer(paths);
      return { ok: true as const, port: serverPort };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeLog("error", "Restart failed:", msg);
      return { ok: false as const, port: serverPort, error: msg };
    }
  });

  // Pick a directory for the next data_root. Does NOT move data — that's
  // deliberate per the "drop-old-data" UX contract; app restart starts fresh
  // in the new location.
  ipcMain.handle("covel:pick-data-dir", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose Covel data directory",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: paths.dataRoot,
    });
    if (result.canceled || !result.filePaths[0]) return { path: null };
    writeDataRoot(result.filePaths[0]);
    return { path: result.filePaths[0] };
  });

  // API keys — plain `KEY=VALUE` lines at ~/.covel/keys.env. No encryption;
  // the primary store (browser localStorage) is plain text anyway, so
  // safeStorage only bought us a macOS Keychain prompt with no real security
  // uplift on an unsigned build.
  ipcMain.handle("covel:keys:load", () => loadKeysEnv(paths.userKeysEnvPath));
  ipcMain.handle("covel:keys:save", async (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") return { ok: false };
    const keys: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (typeof v === "string") keys[k] = v;
    }
    try {
      try {
        await saveKeysViaSidecar(keys);
      } catch (err) {
        writeLog("warn", "keys:save sidecar fallback:", err);
        saveKeysEnv(paths.userKeysEnvPath, keys);
      }
      return { ok: true };
    } catch (err) {
      writeLog("error", "keys:save failed:", err);
      return { ok: false };
    }
  });

  // Settings.json round-trip — the unified SettingsStore's desktop backend.
  // Read returns the `entries` map only; writes accept the full entries blob
  // and rewrite the file atomically with a timestamp for audit purposes.
  ipcMain.handle("covel:settings:load", () => {
    return getSettingsViaSidecar().catch(() => {
      try {
        const raw = fs.readFileSync(paths.userSettingsJsonPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          entries?: Record<string, unknown>;
        };
        return parsed.entries ?? {};
      } catch {
        return {};
      }
    });
  });
  ipcMain.handle("covel:settings:save", async (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") return { ok: false };
    const entries = payload as Record<string, unknown>;
    try {
      try {
        await saveSettingsViaSidecar(entries);
      } catch (err) {
        writeLog("warn", "settings:save sidecar fallback:", err);
        fs.mkdirSync(path.dirname(paths.userSettingsJsonPath), {
          recursive: true,
        });
        const bundle = {
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          entries,
        };
        fs.writeFileSync(
          paths.userSettingsJsonPath,
          JSON.stringify(bundle, null, 2) + "\n",
          { mode: 0o600 },
        );
      }
      return { ok: true };
    } catch (err) {
      writeLog("error", "settings:save failed:", err);
      return { ok: false };
    }
  });

  // Asset import — called with { sourcePath } from the web tier or from the
  // dialog-based "pick" handlers below.
  async function handleImport(
    kind: ImportKind,
    payload: unknown,
  ): Promise<ImportResult> {
    if (!payload || typeof payload !== "object") {
      return { ok: false, kind, message: "Invalid payload" };
    }
    const sourcePath = (payload as { sourcePath?: string }).sourcePath;
    if (typeof sourcePath !== "string") {
      return { ok: false, kind, message: "sourcePath must be a string" };
    }
    try {
      const result = await importAsset(kind, sourcePath);
      writeLog(
        result.ok ? "info" : "warn",
        `import(${kind}) ${result.ok ? "ok" : "failed"}: ${
          result.message ?? result.itemName ?? ""
        }`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeLog("error", `import(${kind}) threw: ${message}`);
      return { ok: false, kind, message };
    }
  }

  ipcMain.handle("covel:import:plugin", (_event, payload) =>
    handleImport("plugin", payload),
  );
  ipcMain.handle("covel:import:world", (_event, payload) =>
    handleImport("world", payload),
  );

  // Dialog-backed entry points. Open a native file chooser, then import.
  async function pickAndImport(kind: ImportKind): Promise<ImportResult> {
    const win = mainWindow ?? undefined;
    const picked = await dialog.showOpenDialog(win as BrowserWindow, {
      title: kind === "plugin" ? "Import Plugin" : "Import World Package",
      properties: ["openFile", "openDirectory", "treatPackageAsDirectory"],
      filters: [
        { name: "Zip archives", extensions: ["zip"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, kind, message: "Cancelled" };
    }
    return handleImport(kind, { sourcePath: picked.filePaths[0] });
  }

  ipcMain.handle("covel:import:pick-plugin", () => pickAndImport("plugin"));
  ipcMain.handle("covel:import:pick-world", () => pickAndImport("world"));
}

// ── Native Menu ────────────────────────────────────────────────

/** Emit a typed IPC message to the focused / main window. */
function sendMenuAction(channel: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel);
}

function buildAppMenu(): Electron.Menu {
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const, label: "About Covel" },
              { type: "separator" as const },
              {
                label: "Settings\u2026",
                accelerator: "CmdOrCtrl+,",
                click: () => sendMenuAction("covel:menu:open-settings"),
              },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ] as Electron.MenuItemConstructorOptions[],
          },
        ]
      : []),

    {
      label: "File",
      submenu: [
        {
          label: "New World",
          accelerator: "CmdOrCtrl+N",
          click: () => sendMenuAction("covel:menu:new-world"),
        },
        {
          label: "Import Plugin\u2026",
          click: () => {
            // Route through the renderer so UI can show success/error toasts
            sendMenuAction("covel:menu:import-plugin");
          },
        },
        {
          label: "Import World\u2026",
          click: () => {
            sendMenuAction("covel:menu:import-world");
          },
        },
        { type: "separator" },
        {
          label: "Export Chat\u2026",
          accelerator: "CmdOrCtrl+Shift+E",
          click: () => sendMenuAction("covel:menu:export-chat"),
        },
        { type: "separator" },
        ...(!isMac
          ? [
              {
                label: "Settings\u2026",
                accelerator: "CmdOrCtrl+,",
                click: () => sendMenuAction("covel:menu:open-settings"),
              },
              { type: "separator" as const },
            ]
          : []),
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ] as Electron.MenuItemConstructorOptions[],
    },

    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ] as Electron.MenuItemConstructorOptions[],
    },

    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom", label: "Actual Size" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ] as Electron.MenuItemConstructorOptions[],
    },

    {
      role: "help",
      submenu: [
        {
          label: "Documentation",
          click: () => shell.openExternal("https://github.com/AcKnEsS/covel"),
        },
      ] as Electron.MenuItemConstructorOptions[],
    },
  ];

  return Menu.buildFromTemplate(template);
}

// ── Context Menu ───────────────────────────────────────────────

function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.selectionText)
      items.push({ role: "copy" }, { type: "separator" });
    items.push({ role: "selectAll" });
    if (isDev) {
      items.push(
        { type: "separator" },
        {
          label: "Inspect Element",
          click: () => win.webContents.inspectElement(params.x, params.y),
        },
      );
    }
    Menu.buildFromTemplate(items).popup();
  });
}

function attachTitleSync(win: BrowserWindow): void {
  win.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    if (title) win.setTitle(title);
  });
  win.webContents.on("did-navigate-in-page", () => {
    win.webContents
      .executeJavaScript("document.title")
      .then((title: string) => {
        if (title) win.setTitle(title);
      })
      .catch(() => {});
  });
}

// ── External link guard ─────────────────────────────────────────

/**
 * Decide whether a `window.open()` / target=_blank link should be handed off
 * to the system browser. Layered policy (audit Stage 7):
 *
 *   - `https:` → silently opened, host audited to desktop.log
 *   - `http:`  → user confirm dialog (plaintext is the real risk surface)
 *   - everything else (`javascript:`, `file:`, `chrome-extension:`, custom
 *     schemes) → blocked, no log spam unless it looks intentional
 *
 * Loopback `http://localhost`/`http://127.0.0.1` URLs auto-allow so dev
 * tools and self-hosted plugin assets don't trigger a confirm storm.
 */
function handleExternalLinkRequest(
  parent: BrowserWindow,
  linkUrl: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(linkUrl);
  } catch {
    writeLog("warn", `[external-link] blocked unparseable URL: ${linkUrl}`);
    return;
  }

  const protocol = parsed.protocol;
  const host = parsed.host;

  if (protocol === "https:") {
    writeLog("info", `[external-link] https → ${host}`);
    void shell.openExternal(linkUrl);
    return;
  }

  if (protocol === "http:") {
    const isLoopback =
      host === "localhost" || host.startsWith("127.") || host === "[::1]";
    if (isLoopback) {
      writeLog("info", `[external-link] http loopback → ${host}`);
      void shell.openExternal(linkUrl);
      return;
    }
    // Synchronously prompt — `setWindowOpenHandler` returns immediately
    // either way, but the user gets a chance to opt out before the system
    // browser launches. `dialog.showMessageBoxSync` blocks the main process
    // briefly which is fine for an explicit user action.
    const choice = dialog.showMessageBoxSync(parent, {
      type: "warning",
      buttons: ["Open", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Open external link?",
      message: `Open ${host} in your browser?`,
      detail: `${linkUrl}\n\nThis link uses unencrypted http. Only proceed if you trust the source.`,
    });
    if (choice === 0) {
      writeLog("info", `[external-link] http (user-confirmed) → ${host}`);
      void shell.openExternal(linkUrl);
    } else {
      writeLog("info", `[external-link] http (user-cancelled) → ${host}`);
    }
    return;
  }

  // Hard block for all other protocols. Log only when the URL was clearly
  // meant to be a link (not e.g. an empty about:blank).
  writeLog(
    "warn",
    `[external-link] blocked protocol ${protocol} (${host || linkUrl.slice(0, 80)})`,
  );
}

// ── Window ──────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

function sharedWebPreferences(): Electron.WebPreferences {
  return {
    preload: resolvePreloadScript(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // Expose the app version to the preload script for the renderer
    additionalArguments: [`--covel-app-version=${app.getVersion()}`],
  };
}

function createMainWindow(titleSuffix?: string): BrowserWindow {
  const restored = resolveInitialWindowOptions();
  const icon = resolveWindowIconPath();

  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  const win = new BrowserWindow({
    x: restored.x,
    y: restored.y,
    width: restored.width,
    height: restored.height,
    minWidth: 1024,
    minHeight: 680,
    title: titleSuffix ? `Covel ${titleSuffix}` : "Covel",
    backgroundColor: "#09090b",
    show: false,
    icon: icon && fs.existsSync(icon) ? icon : undefined,
    // Hide the native title bar so the in-app header can extend to the top
    // edge and follow the active theme. Traffic lights stay (hiddenInset on
    // macOS); on Windows the WCO overlay draws controls in app colours.
    titleBarStyle: isMac ? "hiddenInset" : isWin ? "hidden" : "default",
    trafficLightPosition: isMac ? { x: 16, y: 14 } : undefined,
    titleBarOverlay: isWin
      ? { color: "#09090b", symbolColor: "#fafafa", height: 36 }
      : undefined,
    webPreferences: sharedWebPreferences(),
  });

  // Apply persisted maximize/fullscreen flags before first paint so we don't
  // flash a smaller window before jumping to fullscreen.
  if (restored.initial.fullScreen) {
    win.setFullScreen(true);
  } else if (restored.initial.maximize) {
    win.maximize();
  }

  win.once("ready-to-show", () => win.show());

  attachContextMenu(win);
  attachTitleSync(win);
  attachWindowStateTracking(win);
  win.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
    handleExternalLinkRequest(win, linkUrl);
    return { action: "deny" };
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

function loadSplashInto(win: BrowserWindow): void {
  const html = buildSplashHtml();
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function navigateToApp(win: BrowserWindow, port: number): void {
  const url = `http://127.0.0.1:${port}/session`;
  writeLog("info", `Loading ${url}`);
  win.loadURL(url);
}

/** Production startup: splash screen → server start → navigate to app. Retries on failure. */
async function productionStartup(
  paths: ReturnType<typeof ensureUserPaths>,
): Promise<void> {
  const win = createMainWindow();
  mainWindow = win;
  loadSplashInto(win);

  const attemptStart = async (): Promise<void> => {
    serverStderrLines.length = 0;
    try {
      await startServer(paths);
      await new Promise((r) => setTimeout(r, 400));
      navigateToApp(win, serverPort);
    } catch (err) {
      const diag = diagnoseStartupError(err);
      writeLog("error", `Startup failed: ${diag.title}: ${diag.detail}`);

      const logs = serverStderrLines.slice(-80).join("\n");
      // Reset splash back if we already navigated
      loadSplashInto(win);
      // Wait a tick for the splash to mount before sending the error
      setTimeout(() => broadcastStartupError(diag, logs), 150);

      await new Promise<void>((resolve) => {
        pendingRetrySignal = () => resolve();
      });

      await stopServer();
      restartAttempts = 0;
      loadSplashInto(win);
      await attemptStart();
    }
  };

  await attemptStart();
}

async function devStartup(
  paths: ReturnType<typeof ensureUserPaths>,
): Promise<void> {
  // In dev we still ensure userData exists and use it, so dev == prod.
  // The Vite dev server handles the frontend at 5173; ensure it's reachable first.
  serverPort = 5173;
  writeLog(
    "info",
    "Dev mode: using external dev server at http://localhost:5173",
  );

  try {
    await waitForServer("http://localhost:5173", 3_000, 100);
  } catch {
    writeLog(
      "warn",
      "Dev server not reachable at http://localhost:5173 — continuing anyway. Run `pnpm dev` in another terminal.",
    );
  }

  const win = createMainWindow("(Dev)");
  mainWindow = win;
  win.loadURL("http://localhost:5173/session");
  win.webContents.openDevTools({ mode: "detach" });
  // Silence unused-paths warning — dev currently relies on external dev server,
  // userData is still prepared so dev/prod stay aligned.
  void paths;
}

// ── App lifecycle ───────────────────────────────────────────────

app.on("window-all-closed", () => {
  // App is exiting; fire-and-forget the stop. The kernel will reap the
  // child when our process dies even if the SIGTERM grace period overruns.
  void stopServer();
  app.quit();
});

app.on("before-quit", () => {
  void stopServer();
});

app.whenReady().then(async () => {
  const paths = ensureUserPaths();
  initPersistentLog(paths.logsDir, paths.logRotation);
  registerIpcHandlers(paths);
  Menu.setApplicationMenu(buildAppMenu());

  try {
    if (isDev) {
      await devStartup(paths);
    } else {
      await productionStartup(paths);
    }
  } catch (err) {
    writeLog("error", "Fatal:", err);
    app.quit();
  }

  // Fire-and-forget: auto-updater is opt-in via COVEL_AUTO_UPDATE=1.
  // Deliberately awaited outside the try/catch above so update failures
  // never cascade into a "Fatal" shutdown.
  void initAutoUpdater({
    disabled: isDev,
    window: () => mainWindow,
    log: (level, ...parts) => writeLog(level, ...parts),
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort > 0) {
      const win = createMainWindow();
      mainWindow = win;
      navigateToApp(win, serverPort);
    }
  });
});
