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
import {
  loadEnvFiles,
  loadKeysEnv,
  loadKeysEnvForChild,
  saveKeysEnv,
} from "./env-files.js";
import { findFreePort, isPortFree, waitForServer } from "./network.js";
import { diagnoseStartupError, type DiagnosedError } from "./startup-errors.js";
import { buildSplashHtml } from "./splash-screen.js";
import {
  initPersistentLog,
  writeLog,
  writeServerStreamLine,
} from "./logging.js";

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
  initPersistentLog(paths.logsDir, paths.logRotation, app.getVersion());
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
