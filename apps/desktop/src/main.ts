/**
 * Covel Desktop — Electron main process.
 *
 * Architecture: sidecar pattern.
 *   0. Take the single-instance lock; a second launch focuses the first
 *   1. Resolve paths, ensure userData directories exist
 *   2. Pick the port: the previous one while it is free, else a free one
 *   3. Show splash screen with loading animation
 *   4. Spawn the Hono API server as a child process
 *   5. Wait for private readiness IPC, with progress updates and retry on failure
 *   6. Navigate to the app URL; bind menu and IPC handlers
 *   7. Monitor the server and auto-restart on unexpected exit
 *   8. Clean up on quit
 */

import { app, BrowserWindow, Menu, session } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  ensureUserPaths,
  isDev,
  resolveProjectRoot,
  resolveServerEntry,
  resolveTsx,
  userServerPortFile,
} from "./paths.js";
import { loadChildEnvironment } from "./env-files.js";
import {
  fetchWithTimeout,
  findPreferredPort,
  parseStoredPort,
  waitForServer,
} from "./network.js";
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
import { archiveUnusableSettingsFile } from "./settings-json.js";
import {
  buildAppMenu,
  createMainWindow,
  getMainWindow,
  loadSplashInto,
  navigateToApp,
} from "./windows.js";
import { initDesktopI18n, t } from "./main-i18n.js";
import { resolveSystemProxyRequest } from "./system-proxy.js";
import { showAppUpdateNotification } from "./app-update-notification.js";
import { createQuitHandler, stopServerProcess } from "./server-shutdown.js";
import { waitForServerProcess } from "./server-readiness.js";
import { createServerRecovery, findStartablePort } from "./server-recovery.js";
import { claimSingleInstance } from "./single-instance.js";
import { staleLoopbackOrigins } from "./stale-origins.js";
import {
  parseSettingsPersistenceBundle,
  type SettingsPersistenceBundle,
} from "@covel/shared/settings-persistence";

// Before anything else starts: a second Covel must not reach the point where
// it prepares directories or spawns a sidecar on the database the first one
// has open. The lock is tied to the user-data directory, which follows the
// name set above. A development shell starts no sidecar and shares that name
// with the installed app, so it takes no lock.
const ownsInstance = isDev || claimSingleInstance(app, getMainWindow);

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

export class SidecarUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SidecarUnavailableError";
  }
}

export class SidecarHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly revision?: number,
  ) {
    super(message);
    this.name = "SidecarHttpError";
  }
}

async function requestSidecarConfig<T>(
  pathName: string,
  init?: RequestInit,
): Promise<T> {
  // Dev mode starts no sidecar. The external dev server runs without
  // COVEL_DESKTOP_REST: it answers an empty settings bundle and refuses
  // writes, so the files of this home are read and written directly.
  if (isDev) throw new SidecarUnavailableError("no sidecar in dev mode");
  if (serverPort <= 0) throw new SidecarUnavailableError("sidecar not ready");
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${serverPort}${pathName}`, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${desktopRestToken}`,
      },
    });
  } catch (error) {
    throw new SidecarUnavailableError("sidecar request failed", {
      cause: error,
    });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      code?: unknown;
      details?: { revision?: unknown };
    } | null;
    throw new SidecarHttpError(
      res.status,
      `sidecar ${pathName} failed: ${res.status}`,
      typeof body?.code === "string" ? body.code : undefined,
      typeof body?.details?.revision === "number"
        ? body.details.revision
        : undefined,
    );
  }
  return (await res.json()) as T;
}

async function getSettingsViaSidecar(): Promise<SettingsPersistenceBundle> {
  return parseSettingsPersistenceBundle(
    await requestSidecarConfig<unknown>("/api/config/settings"),
  );
}

async function saveSettingsViaSidecar(
  entries: Record<string, unknown>,
  expectedRevision: number,
): Promise<SettingsPersistenceBundle> {
  return parseSettingsPersistenceBundle(
    await requestSidecarConfig<unknown>("/api/config/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries, expectedRevision }),
    }),
  );
}

async function saveKeysViaSidecar(
  keys: Record<string, string | null>,
): Promise<void> {
  await requestSidecarConfig<{ ok?: boolean }>("/api/config/keys", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(keys),
  });
}

// ── Server lifecycle ────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;
let serverPort = 0;
let manualStop = false;
let quitting = false;
let serverPaths: ReturnType<typeof ensureUserPaths> | undefined;

const serverRecovery = createServerRecovery<ChildProcess>({
  restart: () => {
    if (!serverPaths) throw new Error("Server paths are unavailable");
    return startServer(serverPaths);
  },
  navigate: (port) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) navigateToApp(win, port);
  },
  status: (state, attempts, delay) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("covel:server:status", { state, attempts, delay });
      }
    }
  },
  log: (message, error) => writeLog("error", message, error),
});

// Per-launch bearer token for privileged /api/config/* writes. Generated
// once at app startup and reused across sidecar restarts so the renderer's
// stored token stays valid through "save data root → restart sidecar".
// Regenerated only on a full app relaunch.
const desktopRestToken = randomUUID();

// Per-launch secret for signing short-lived media access tokens
// (`/api/sessions/:id/media-token`). The sidecar runs with NODE_ENV=production,
// where the server refuses to issue tokens with an ephemeral per-process
// secret — so without this, every `<Media>` (character portraits, generated
// images) fails to load. Tokens are 5-minute TTL and the renderer re-requests
// them, so a fresh secret per launch is fine. A user-provided
// COVEL_MEDIA_TOKEN_SECRET (process env or a repo .env file) still wins.
const desktopMediaTokenSecret = randomBytes(32).toString("base64url");

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

/** The port the last sidecar ran on, from `server.port`. */
function readPreviousPort(portFile: string): number | undefined {
  try {
    return parseStoredPort(fs.readFileSync(portFile, "utf-8"));
  } catch {
    // First launch, or an unreadable file: there is no port to prefer.
    return undefined;
  }
}

/**
 * Clear what the page origins of earlier launches stored. Nothing reads it
 * again: the origin of this launch is another one (see `stale-origins.ts`).
 * The HTTP cache is keyed by URL, so its entries of those origins go with it.
 */
async function clearStaleOriginStorage(port: number): Promise<void> {
  try {
    const stale = staleLoopbackOrigins(
      await fs.promises.readdir(
        path.join(app.getPath("userData"), "IndexedDB"),
      ),
      port,
    );
    if (stale.length === 0) return;
    for (const origin of stale)
      await session.defaultSession.clearStorageData({ origin });
    await session.defaultSession.clearCache();
    writeLog(
      "info",
      `Cleared the storage of ${stale.length} earlier page origin(s)`,
    );
  } catch (error) {
    // Left-over storage costs disk space only; the app runs without this.
    writeLog(
      "warn",
      `Could not clear earlier page storage: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function startServer(
  paths: ReturnType<typeof ensureUserPaths>,
): Promise<number> {
  if (serverProcess) throw new Error("Server process is already running");
  manualStop = false;
  serverPaths = paths;
  const portFile = userServerPortFile();
  const port = await findStartablePort(
    () => findPreferredPort(readPreviousPort(portFile)),
    () => quitting || manualStop,
  );
  fs.writeFileSync(portFile, String(port), "utf-8");

  const serverEntry = resolveServerEntry();
  const projectRoot = resolveProjectRoot();
  const tsxPath = resolveTsx();

  const configuredEnv = loadChildEnvironment(
    projectRoot,
    paths.userKeysEnvPath,
    process.env,
  );
  // Data dir lives at <dataRoot>/; ensure the db's parent (and logs dir) exist.
  fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });

  const env: Record<string, string> = {
    ...configuredEnv,
    SERVER_PORT: String(port),
    STORE_BACKEND: configuredEnv.STORE_BACKEND ?? "sqlite",
    SQLITE_PATH: paths.dbPath,
    NODE_ENV: isDev ? "development" : "production",
    ...(isDev ? {} : { SERVE_STATIC: "true" }),
    COVEL_HOME: paths.covelHome,
    COVEL_DATA_ROOT: paths.dataRoot,
    COVEL_DESKTOP_REST: "1",
    COVEL_DESKTOP_REST_TOKEN: desktopRestToken,
    COVEL_MEDIA_TOKEN_SECRET:
      configuredEnv.COVEL_MEDIA_TOKEN_SECRET ?? desktopMediaTokenSecret,
    COVEL_PLUGINS_DIR: paths.pluginsDirs[0] ?? "",
    COVEL_WORLDS_DIR: paths.worldsDirs[0] ?? "",
    COVEL_USER_WORLDS_DIR: paths.userWorldsDir,
    COVEL_USER_PLUGINS_DIR: paths.userPluginsDir,
    COVEL_USER_CONFIG_DIR: paths.covelHome,
    COVEL_LLM_TOML: paths.userLlmTomlPath,
    COVEL_LOGS_DIR: paths.logsDir,
    COVEL_LOG_MAX_SIZE_MB: String(paths.logRotation.maxSizeMb),
    COVEL_LOG_MAX_FILES: String(paths.logRotation.maxFiles),
    COVEL_DESKTOP_SYSTEM_PROXY_IPC: "1",
  };

  if (!isDev) {
    env.STATIC_DIR = path.join(process.resourcesPath!, "web-dist");
  }

  writeLog("info", `Starting server on port ${port}`);
  writeLog("info", `plugin TypeScript loader: ${tsxPath}`);
  writeLog("info", `entry: ${serverEntry}`);
  writeLog("info", `cwd: ${projectRoot}`);
  writeLog("info", `db: ${paths.dbPath}`);
  writeLog("info", `llm.toml: ${paths.userLlmTomlPath}`);
  writeLog("info", "system proxy: dynamic Electron resolver available");

  const spawnEnv: Record<string, string> = { ...env };
  const nodeBin = isDev ? "node" : process.execPath;
  if (!isDev) {
    spawnEnv.ELECTRON_RUN_AS_NODE = "1";
  }
  writeLog("info", `node: ${nodeBin}`);

  // `--import` takes a module specifier, not a path: Node reads the drive
  // letter of an absolute Windows path as a URL scheme and refuses it.
  serverProcess = spawn(
    nodeBin,
    ["--import", pathToFileURL(tsxPath).href, serverEntry],
    {
      cwd: projectRoot,
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  serverPort = port;
  const startedAt = Date.now();

  const child = serverProcess;
  child.on("error", (error) => {
    writeLog("warn", "Server process error:", error);
  });
  child.on("message", async (message) => {
    const response = await resolveSystemProxyRequest(message, (url) =>
      session.defaultSession.resolveProxy(url),
    );
    if (!response || !child.connected) return;
    try {
      child.send(response, (error) => {
        if (error) {
          writeLog("warn", "Could not return system proxy result:", error);
        }
      });
    } catch (error) {
      writeLog("warn", "Could not return system proxy result:", error);
    }
  });

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
    const uptime = Date.now() - startedAt;
    writeLog(
      "warn",
      `Server exited (code=${code}, signal=${signal}, uptime=${uptime}ms)`,
    );
    if (serverProcess === child) {
      serverProcess = null;
      serverPort = 0;
      stopHealthHeartbeat();
    }

    // Only auto-restart on unexpected exit after a successful boot.
    if (!manualStop && !quitting) serverRecovery.exited(child);
  });

  // Wait for this child's listening acknowledgement with progress updates
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  writeLog("info", `Waiting for sidecar readiness IPC on port ${port}`);
  broadcastProgress(t("startup.status.startingServer"));

  const PROGRESS_STEPS: Array<{ threshold: number; label: string }> = [
    { threshold: 0, label: t("startup.status.startingServer") },
    { threshold: 1_500, label: t("startup.status.loadingPlugins") },
    { threshold: 6_000, label: t("startup.status.initializingDatabase") },
    { threshold: 15_000, label: t("startup.status.almostReady") },
  ];

  try {
    await waitForServerProcess(child, port, (elapsed) => {
      if (quitting || manualStop)
        throw new Error("Application is shutting down");
      let currentLabel = PROGRESS_STEPS[0].label;
      for (const step of PROGRESS_STEPS) {
        if (elapsed >= step.threshold) currentLabel = step.label;
      }
      broadcastProgress(currentLabel);
    });
    if (
      quitting ||
      manualStop ||
      serverProcess !== child ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      throw new Error("Server exited before readiness");
    }
  } catch (error) {
    if (serverProcess === child) {
      await stopServerProcess(child, writeLog);
      serverProcess = null;
      serverPort = 0;
    }
    throw error;
  }

  broadcastProgress(t("startup.status.ready"));
  writeLog("info", `Server ready on port ${port}`);
  serverRecovery.ready(child);
  startHealthHeartbeat(healthUrl);

  return port;
}

// ── Health heartbeat ────────────────────────────────────────────

let heartbeatTimer: NodeJS.Timeout | null = null;
let lastHealthOk = true;

function startHealthHeartbeat(healthUrl: string): void {
  stopHealthHeartbeat();
  heartbeatTimer = setInterval(async () => {
    try {
      const res = await fetchWithTimeout(healthUrl, 5_000);
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
 * Wait for confirmed child exit before allowing another sidecar to start.
 * Concurrent calls share the same in-flight promise — the second restart
 * click while shutdown is mid-flight does not double-send signals.
 */
let pendingStop: Promise<void> | null = null;

function stopServer(): Promise<void> {
  if (pendingStop) return pendingStop;

  manualStop = true;
  stopHealthHeartbeat();
  pendingStop = serverRecovery
    .cancel()
    .then(async () => {
      const child = serverProcess;
      if (!child) return;
      await stopServerProcess(child, writeLog);
      if (serverProcess === child) {
        serverProcess = null;
        serverPort = 0;
      }
    })
    .finally(() => {
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
      // The sidecar has acknowledged listening, so load the app now.
      await startServer(paths);
      if (quitting) return;
      navigateToApp(win, serverPort);
      void clearStaleOriginStorage(serverPort);
    } catch (err) {
      if (quitting) return;
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
      serverRecovery.resetBudget();
      loadSplashInto(win);
      await attemptStart();
    }
  };

  await attemptStart();
}

// The dev server is reached by name: Vite may listen on the IPv6 loopback
// only, where `127.0.0.1` is refused.
function openDevWindow(): BrowserWindow {
  const win = createMainWindow("(Dev)");
  win.loadURL("http://localhost:5173/session");
  return win;
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

  const win = openDevWindow();
  win.webContents.openDevTools({ mode: "detach" });
  // Silence unused-paths warning — dev currently relies on external dev server,
  // userData is still prepared so dev/prod stay aligned.
  void paths;
}

// ── App lifecycle ───────────────────────────────────────────────

app.on("window-all-closed", () => {
  app.quit();
});

const quitAfterServerStops = createQuitHandler(
  stopServer,
  () => app.quit(),
  writeLog,
);
app.on("before-quit", (event) => {
  quitting = true;
  quitAfterServerStops(event);
});

// The first Covel shows its window when this launch is turned away.
if (!ownsInstance) app.quit();

app.whenReady().then(async () => {
  if (quitting || !ownsInstance) return;
  const paths = ensureUserPaths();
  initDesktopI18n(paths.userSettingsJsonPath, app.getLocale());
  initPersistentLog(paths.logsDir, paths.logRotation, app.getVersion());
  // Before the sidecar or the window reads settings.json. The locale above
  // was still read from the old file, so this launch keeps its language.
  let archivedSettings: string | null = null;
  try {
    archivedSettings = archiveUnusableSettingsFile(paths.userSettingsJsonPath);
    if (archivedSettings) {
      writeLog(
        "warn",
        `this version cannot use settings.json; it was moved to ${archivedSettings} and settings start from their defaults`,
      );
    }
  } catch (err) {
    writeLog("error", "Could not move the unusable settings.json aside:", err);
  }
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
        serverRecovery.resetBudget();
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
    takeArchivedSettings: () => {
      const file = archivedSettings;
      archivedSettings = null;
      return file;
    },
  });
  Menu.setApplicationMenu(buildAppMenu());

  try {
    if (isDev) {
      await devStartup(paths);
    } else {
      await productionStartup(paths);
      void showAppUpdateNotification({
        currentVersion: app.getVersion(),
        stateFile: path.join(paths.covelHome, "app-update.json"),
        fetchLatestRelease: () =>
          requestSidecarConfig("/api/app-update/latest"),
      }).catch((error: unknown) => {
        writeLog("warn", "Could not show app update notification:", error);
      });
    }
  } catch (err) {
    writeLog("error", "Fatal:", err);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort > 0) {
      if (isDev) {
        openDevWindow();
        return;
      }
      const win = createMainWindow();
      navigateToApp(win, serverPort);
    }
  });
});
