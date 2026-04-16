/**
 * Covel Desktop — Electron main process.
 *
 * Architecture: sidecar pattern.
 *   1. Find a free port
 *   2. Show splash screen with loading animation
 *   3. Spawn the Hono API server as a child process (tsx runtime)
 *   4. Wait for /api/health to respond (with progress updates)
 *   5. Navigate to the server URL (serves static frontend + API)
 *   6. Clean up on quit
 */

import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ── Helpers ──────────────────────────────────────────────────────

const isDev = !app.isPackaged;

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

/** Poll a URL until it returns 200 or timeout. Calls onProgress with elapsed fraction. */
async function waitForServer(
  url: string,
  timeoutMs = 30_000,
  intervalMs = 500,
  onProgress?: (elapsed: number, total: number) => void,
): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    onProgress?.(Date.now() - start, timeoutMs);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

// ── Splash screen ──────────────────────────────────────────────

/** Collected server stderr lines for the "View Logs" feature. */
const serverStderrLines: string[] = [];

function buildSplashHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Covel</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #09090b;
    color: #fafafa;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    -webkit-app-region: drag;
    user-select: none;
  }

  .brand {
    font-size: 42px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: #e4e4e7;
    margin-bottom: 48px;
    opacity: 0;
    animation: fade-in 0.6s ease-out 0.15s forwards;
  }

  /* ── Orbital spinner ── */
  .spinner-wrap {
    position: relative;
    width: 56px;
    height: 56px;
    margin-bottom: 40px;
    opacity: 0;
    animation: fade-in 0.6s ease-out 0.35s forwards;
  }

  .ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid transparent;
  }

  .ring-1 {
    border-top-color: #a1a1aa;
    animation: spin 1.1s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
  }

  .ring-2 {
    inset: 6px;
    border-right-color: #71717a;
    animation: spin 1.6s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite reverse;
  }

  .ring-3 {
    inset: 12px;
    border-bottom-color: #52525b;
    animation: spin 2.2s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
  }

  .dot {
    position: absolute;
    width: 4px;
    height: 4px;
    background: #d4d4d8;
    border-radius: 50%;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; transform: translate(-50%, -50%) scale(1); }
    50% { opacity: 1; transform: translate(-50%, -50%) scale(1.6); }
  }
  @keyframes fade-in { to { opacity: 1; } }

  /* ── Status text ── */
  #status {
    font-size: 13px;
    color: #a1a1aa;
    letter-spacing: 0.04em;
    min-height: 20px;
    opacity: 0;
    animation: fade-in 0.6s ease-out 0.5s forwards;
    transition: color 0.3s ease;
  }

  /* ── Error state ── */
  .error-wrap {
    display: none;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    margin-top: 24px;
    opacity: 0;
    animation: fade-in 0.4s ease-out forwards;
  }

  .error-wrap.visible { display: flex; }

  .error-msg {
    font-size: 13px;
    color: #f87171;
    text-align: center;
    max-width: 420px;
    line-height: 1.5;
  }

  .btn-row {
    display: flex;
    gap: 12px;
    -webkit-app-region: no-drag;
  }

  .btn {
    padding: 8px 20px;
    border-radius: 6px;
    border: 1px solid #27272a;
    background: #18181b;
    color: #d4d4d8;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
    letter-spacing: 0.02em;
  }

  .btn:hover {
    background: #27272a;
    border-color: #3f3f46;
  }

  .btn-primary {
    background: #27272a;
    border-color: #3f3f46;
  }

  .btn-primary:hover {
    background: #3f3f46;
    border-color: #52525b;
  }

  /* ── Log viewer ── */
  #log-viewer {
    display: none;
    margin-top: 16px;
    padding: 12px 16px;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 8px;
    max-width: 560px;
    max-height: 200px;
    overflow-y: auto;
    width: 90vw;
    -webkit-app-region: no-drag;
  }

  #log-viewer.visible { display: block; }

  #log-content {
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 11px;
    color: #a1a1aa;
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.6;
  }
</style>
</head>
<body>
  <div class="brand">COVEL</div>
  <div class="spinner-wrap" id="spinner">
    <div class="ring ring-1"></div>
    <div class="ring ring-2"></div>
    <div class="ring ring-3"></div>
    <div class="dot"></div>
  </div>
  <div id="status">Initializing\u2026</div>

  <div class="error-wrap" id="error-wrap">
    <div class="error-msg" id="error-msg"></div>
    <div class="btn-row">
      <button class="btn btn-primary" id="btn-retry" onclick="window.__covelRetry && window.__covelRetry()">Retry</button>
      <button class="btn" id="btn-logs" onclick="toggleLogs()">View Logs</button>
    </div>
  </div>

  <div id="log-viewer">
    <div id="log-content"></div>
  </div>

  <script>
    function updateStatus(text) {
      document.getElementById('status').textContent = text;
    }

    function showError(msg, logs) {
      document.getElementById('spinner').style.display = 'none';
      document.getElementById('status').style.color = '#71717a';
      document.getElementById('status').textContent = 'Startup failed';
      document.getElementById('error-msg').textContent = msg;
      document.getElementById('error-wrap').classList.add('visible');
      if (logs) {
        document.getElementById('log-content').textContent = logs;
      }
    }

    function toggleLogs() {
      document.getElementById('log-viewer').classList.toggle('visible');
    }
  </script>
</body>
</html>`;
}

/** Send a status update to the splash window. */
function splashSetStatus(win: BrowserWindow | null, text: string): void {
  if (!win || win.isDestroyed()) return;
  const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  win.webContents.executeJavaScript(`updateStatus('${escaped}')`).catch(() => {});
}

/** Show error state in the splash window. Returns a promise that resolves when user clicks Retry. */
function splashShowError(
  win: BrowserWindow | null,
  message: string,
): Promise<void> {
  if (!win || win.isDestroyed()) return Promise.reject(new Error("Window destroyed"));

  const escapedMsg = message.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
  const logs = serverStderrLines.slice(-80).join("\n");
  const escapedLogs = logs.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");

  win.webContents
    .executeJavaScript(`showError('${escapedMsg}', '${escapedLogs}')`)
    .catch(() => {});

  return new Promise((resolve) => {
    win.webContents
      .executeJavaScript(`window.__covelRetry = () => { window.__covelRetrySignal?.(); }`)
      .catch(() => {});
    // Expose a callback that resolves this promise
    win.webContents
      .executeJavaScript(
        `new Promise(resolve => { window.__covelRetrySignal = resolve; })`,
      )
      .then(() => resolve())
      .catch(() => {});
  });
}

// ── Env file loader ─────────────────────────────────────────────

/** Parse a simple .env file (KEY=VALUE, # comments, no multiline). */
function loadEnvFiles(baseDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [".env", ".env.llm"]) {
    const filePath = path.join(baseDir, name);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

// ── Resolve paths ───────────────────────────────────────────────

function resolveProjectRoot(): string {
  if (isDev) {
    // In dev: apps/desktop/dist/main.mjs → project root is ../../..
    return path.resolve(__dirname, "../../..");
  }
  // In packaged app: resources/app/apps/desktop/dist/main.mjs
  // Server code is in resources/server/
  return path.join(process.resourcesPath!, "server");
}

function resolveServerEntry(): string {
  if (isDev) {
    return path.resolve(resolveProjectRoot(), "apps/server/src/index.ts");
  }
  return path.join(process.resourcesPath!, "server", "apps/server/src/index.ts");
}

/** Find tsx CLI entry point by scanning node_modules/.pnpm for tsx. */
function resolveTsx(baseDir: string): string {
  // Direct path: node_modules/tsx (hoisted or packaged)
  const direct = path.join(baseDir, "node_modules/tsx/dist/cli.mjs");
  if (fs.existsSync(direct)) return direct;

  // pnpm structure: node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs
  const pnpmDir = path.join(baseDir, "node_modules/.pnpm");
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (entry.startsWith("tsx@")) {
        const candidate = path.join(pnpmDir, entry, "node_modules/tsx/dist/cli.mjs");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  throw new Error(`tsx not found in ${baseDir}`);
}

function resolveWorldsDir(): string {
  if (isDev) {
    return path.resolve(resolveProjectRoot(), "worlds");
  }
  return path.join(process.resourcesPath!, "server", "worlds");
}

function resolveLlmToml(): string {
  if (isDev) {
    return path.resolve(resolveProjectRoot(), "llm.toml");
  }
  // User can place llm.toml next to the app, or we use the bundled one
  const userPath = path.join(app.getPath("userData"), "llm.toml");
  const bundledPath = path.join(process.resourcesPath!, "server", "llm.toml");
  // Check if user has a custom one (we can't use fs.existsSync in ESM easily,
  // so just return bundled — user config can be added later)
  return bundledPath;
}

// ── Server lifecycle ────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;
let serverPort = 0;

async function startServer(splashWin?: BrowserWindow | null): Promise<number> {
  const port = await findFreePort();
  serverPort = port;

  const serverEntry = resolveServerEntry();
  const projectRoot = resolveProjectRoot();
  const tsxPath = resolveTsx(isDev ? projectRoot : path.join(process.resourcesPath!, "server"));

  // Load .env and .env.llm files from project root (provides LLM API keys)
  const envOverrides = loadEnvFiles(
    isDev ? resolveProjectRoot() : path.join(process.resourcesPath!, "server"),
  );

  // In packaged mode, use SQLite in the user data directory for persistence.
  // ~/Library/Application Support/Covel/data/covel.db (macOS)
  const userDataDir = app.getPath("userData");
  const sqlitePath = isDev
    ? undefined // dev uses default ./data/covel.db
    : path.join(userDataDir, "data", "covel.db");

  if (!isDev && sqlitePath) {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...envOverrides,
    SERVER_PORT: String(port),
    STORE_BACKEND: envOverrides.STORE_BACKEND ?? "sqlite",
    ...(sqlitePath ? { SQLITE_PATH: sqlitePath } : {}),
    NODE_ENV: isDev ? "development" : "production",
    // Only serve static files in production (built web-dist).
    // In dev mode, the Vite dev server handles the frontend.
    ...(isDev ? {} : { SERVE_STATIC: "true" }),
    COVEL_WORLDS_DIR: resolveWorldsDir(),
    COVEL_MEMORY_V1: "1",
  };

  // In production, set STATIC_DIR to the bundled web build
  if (!isDev) {
    env.STATIC_DIR = path.join(process.resourcesPath!, "web-dist");
  }

  console.log(`[desktop] Starting server on port ${port}...`);
  console.log(`[desktop] tsx: ${tsxPath}`);
  console.log(`[desktop] entry: ${serverEntry}`);
  console.log(`[desktop] cwd: ${projectRoot}`);

  // Spawn tsx CLI with server entry as argument.
  // Use system Node.js (not Electron's) because Electron's Node.js has
  // modifications that break tsx's ESM loader registration.
  const nodeBin = isDev ? "node" : path.join(process.resourcesPath!, "node");
  serverProcess = spawn(
    nodeBin,
    [tsxPath, serverEntry],
    {
      cwd: isDev ? projectRoot : path.join(process.resourcesPath!, "server"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    process.stdout.write(`[server] ${text}`);
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    process.stderr.write(`[server:err] ${text}`);
    // Capture for splash "View Logs" feature
    for (const line of text.split("\n")) {
      if (line.trim()) serverStderrLines.push(line);
    }
  });

  serverProcess.on("exit", (code) => {
    console.log(`[desktop] Server exited with code ${code}`);
    serverProcess = null;
  });

  // Wait for health check with splash progress updates
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  console.log(`[desktop] Waiting for ${healthUrl}...`);

  splashSetStatus(splashWin ?? null, "Starting server\u2026");

  const PROGRESS_STEPS: Array<{ threshold: number; label: string }> = [
    { threshold: 0, label: "Starting server\u2026" },
    { threshold: 3_000, label: "Loading plugins\u2026" },
    { threshold: 8_000, label: "Initializing database\u2026" },
    { threshold: 18_000, label: "Almost ready\u2026" },
  ];

  await waitForServer(healthUrl, 30_000, 500, (elapsed) => {
    // Walk through progress steps based on elapsed time
    let currentLabel = PROGRESS_STEPS[0].label;
    for (const step of PROGRESS_STEPS) {
      if (elapsed >= step.threshold) currentLabel = step.label;
    }
    splashSetStatus(splashWin ?? null, currentLabel);
  });

  splashSetStatus(splashWin ?? null, "Ready!");
  console.log(`[desktop] Server ready on port ${port}`);

  return port;
}

function stopServer(): void {
  if (serverProcess) {
    console.log("[desktop] Stopping server...");
    serverProcess.kill("SIGTERM");
    // Force kill after 5s
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill("SIGKILL");
      }
    }, 5000);
    serverProcess = null;
  }
}

// ── Native Menu ────────────────────────────────────────────────

/** Dispatch a CustomEvent into the renderer to communicate with the web app. */
function dispatchWebEvent(name: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript(`window.dispatchEvent(new CustomEvent('${name}'))`)
    .catch(() => {});
}

function buildAppMenu(): Electron.Menu {
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS app menu
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
                click: () => dispatchWebEvent("covel:open-settings"),
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

    // File menu
    {
      label: "File",
      submenu: [
        {
          label: "New World",
          accelerator: "CmdOrCtrl+N",
          click: () => dispatchWebEvent("covel:new-world"),
        },
        { type: "separator" },
        {
          label: "Export Chat\u2026",
          accelerator: "CmdOrCtrl+Shift+E",
          click: () => dispatchWebEvent("covel:export-chat"),
        },
        { type: "separator" },
        ...(!isMac
          ? [
              {
                label: "Settings\u2026",
                accelerator: "CmdOrCtrl+,",
                click: () => dispatchWebEvent("covel:open-settings"),
              },
              { type: "separator" as const },
            ]
          : []),
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ] as Electron.MenuItemConstructorOptions[],
    },

    // Edit menu
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

    // View menu
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

    // Help menu
    {
      role: "help",
      submenu: [
        {
          label: "Documentation",
          click: () => {
            shell.openExternal("https://github.com/AcKnEsS/covel");
          },
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

    if (params.selectionText) {
      items.push({ role: "copy" }, { type: "separator" });
    }

    items.push({ role: "selectAll" });

    if (isDev) {
      items.push({ type: "separator" }, {
        label: "Inspect Element",
        click: () => win.webContents.inspectElement(params.x, params.y),
      });
    }

    Menu.buildFromTemplate(items).popup();
  });
}

// ── Window Title ───────────────────────────────────────────────

/** Sync the native window title with the page's document.title after navigations. */
function attachTitleSync(win: BrowserWindow): void {
  win.webContents.on("page-title-updated", (event, title) => {
    // Prevent the default which sets title from <title> — we control it explicitly
    event.preventDefault();
    if (title) {
      win.setTitle(title);
    }
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

// ── Window ──────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

/** Create the splash window for production mode. Loads inline HTML. */
function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "Covel",
    backgroundColor: "#09090b",
    webPreferences: {
      contextIsolation: false, // needed for executeJavaScript callbacks
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const html = buildSplashHtml();
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  return win;
}

/** Navigate existing window to the app URL after server is ready. */
function navigateToApp(win: BrowserWindow, port: number): void {
  const url = `http://127.0.0.1:${port}/session`;
  console.log(`[desktop] Loading ${url}`);
  win.loadURL(url);

  // Open external links in system browser
  win.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
    if (linkUrl.startsWith("http")) {
      shell.openExternal(linkUrl);
    }
    return { action: "deny" };
  });

  attachContextMenu(win);
  attachTitleSync(win);

  win.on("closed", () => {
    mainWindow = null;
  });
}

function createDevWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "Covel (Dev)",
    backgroundColor: "#09090b",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL("http://localhost:5173/session");
  mainWindow.webContents.openDevTools({ mode: "detach" });
  mainWindow.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
    if (linkUrl.startsWith("http")) shell.openExternal(linkUrl);
    return { action: "deny" };
  });
  attachContextMenu(mainWindow);
  attachTitleSync(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Production startup: splash screen -> server start -> navigate to app. Retries on failure. */
async function productionStartup(): Promise<void> {
  const splashWin = createSplashWindow();
  mainWindow = splashWin;

  const attemptStart = async (): Promise<void> => {
    // Reset stderr capture for this attempt
    serverStderrLines.length = 0;

    try {
      const port = await startServer(splashWin);
      serverPort = port;

      // Brief pause so the "Ready!" text is visible
      await new Promise((r) => setTimeout(r, 400));

      // Upgrade sandbox/contextIsolation for the real app content
      // We reuse the same window — just navigate away from the data: URL
      navigateToApp(splashWin, port);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error during startup";
      console.error(`[desktop] Startup failed: ${message}`);

      // Show error in splash, wait for retry
      await splashShowError(splashWin, message);

      // User clicked Retry — stop previous server attempt and try again
      stopServer();
      splashSetStatus(splashWin, "Retrying\u2026");

      // Restore spinner visibility
      splashWin.webContents
        .executeJavaScript(
          `document.getElementById('spinner').style.display = '';
           document.getElementById('error-wrap').classList.remove('visible');
           document.getElementById('log-viewer').classList.remove('visible');
           document.getElementById('status').style.color = '#a1a1aa';`,
        )
        .catch(() => {});

      await attemptStart();
    }
  };

  await attemptStart();
}

// ── App lifecycle ───────────────────────────────────────────────

app.on("window-all-closed", () => {
  stopServer();
  app.quit();
});

app.on("before-quit", () => {
  stopServer();
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildAppMenu());

  try {
    if (isDev) {
      // In dev mode, rely on existing dev servers (pnpm dev).
      serverPort = 5173;
      console.log("[desktop] Dev mode: using existing dev servers");
      createDevWindow();
    } else {
      await productionStartup();
    }
  } catch (err) {
    console.error("[desktop] Fatal:", err);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort > 0) {
      const win = createSplashWindow();
      mainWindow = win;
      navigateToApp(win, serverPort);
    }
  });
});
