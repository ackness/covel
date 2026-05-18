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

import { app, BrowserWindow, Menu } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

import {
  ensureUserPaths,
  isDev,
  resolveProjectRoot,
  resolveServerEntry,
  resolveTsx,
  userServerPortFile,
} from "./paths.js";
import { loadEnvFiles, loadKeysEnvForChild } from "./env-files.js";
import { findFreePort, isPortFree, waitForServer } from "./network.js";
import { diagnoseStartupError, type DiagnosedError } from "./startup-errors.js";
import {
  initPersistentLog,
  writeLog,
  writeServerStreamLine,
} from "./logging.js";

// Name matters on macOS (app menu "About …") and Windows (DPAPI service
// label if we ever re-introduce secure-storage). Derived default would be
// "@covel/desktop" from package.json — override to the friendly product name.
app.setName("Covel");
import { registerDesktopIpcHandlers } from "./ipc-handlers.js";
import { initAutoUpdater } from "./auto-updater.js";
import {
  buildAppMenu,
  createMainWindow,
  getMainWindow,
  loadSplashInto,
  navigateToApp,
} from "./windows.js";

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

// ── IPC retry signal ────────────────────────────────────────────

type RetrySignal = () => void;
let pendingRetrySignal: RetrySignal | null = null;

/** Production startup: splash screen → server start → navigate to app. Retries on failure. */
async function productionStartup(
  paths: ReturnType<typeof ensureUserPaths>,
): Promise<void> {
  const win = createMainWindow();
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
  initPersistentLog(paths.logsDir, paths.logRotation, app.getVersion());
  registerDesktopIpcHandlers({
    paths,
    isDev,
    getServerPort: () => serverPort,
    restToken: desktopRestToken,
    retryStartup: () => {
      if (pendingRetrySignal) {
        const fn = pendingRetrySignal;
        pendingRetrySignal = null;
        fn();
      }
    },
    restartServer: async () => {
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
    },
    getSettingsViaSidecar,
    saveSettingsViaSidecar,
    saveKeysViaSidecar,
  });
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
    window: () => getMainWindow(),
    log: (level, ...parts) => writeLog(level, ...parts),
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort > 0) {
      const win = createMainWindow();
      navigateToApp(win, serverPort);
    }
  });
});
