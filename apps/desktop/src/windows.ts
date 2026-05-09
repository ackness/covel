import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  type MenuItemConstructorOptions,
  type WebPreferences,
} from "electron";
import fs from "node:fs";

import { isDev, resolvePreloadScript, resolveWindowIconPath } from "./paths.js";
import {
  attachWindowStateTracking,
  resolveInitialWindowOptions,
} from "./window-state.js";
import { buildSplashHtml } from "./splash-screen.js";
import { writeLog } from "./logging.js";

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Emit a typed IPC message to the focused / main window. */
function sendMenuAction(channel: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel);
}

export function buildAppMenu(): Electron.Menu {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
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
            ] as MenuItemConstructorOptions[],
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
            // Route through the renderer so UI can show success/error toasts.
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
      ] as MenuItemConstructorOptions[],
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
      ] as MenuItemConstructorOptions[],
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
      ] as MenuItemConstructorOptions[],
    },

    {
      role: "help",
      submenu: [
        {
          label: "Documentation",
          click: () => shell.openExternal("https://github.com/AcKnEsS/covel"),
        },
      ] as MenuItemConstructorOptions[],
    },
  ];

  return Menu.buildFromTemplate(template);
}

function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    if (params.selectionText) {
      items.push({ role: "copy" }, { type: "separator" });
    }
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

/**
 * Decide whether a `window.open()` / target=_blank link should be handed off
 * to the system browser. HTTPS opens directly, loopback HTTP opens directly,
 * external HTTP requires confirmation, and all other schemes are blocked.
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
    writeLog("info", `[external-link] https -> ${host}`);
    void shell.openExternal(linkUrl);
    return;
  }

  if (protocol === "http:") {
    const isLoopback =
      host === "localhost" || host.startsWith("127.") || host === "[::1]";
    if (isLoopback) {
      writeLog("info", `[external-link] http loopback -> ${host}`);
      void shell.openExternal(linkUrl);
      return;
    }

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
      writeLog("info", `[external-link] http (user-confirmed) -> ${host}`);
      void shell.openExternal(linkUrl);
    } else {
      writeLog("info", `[external-link] http (user-cancelled) -> ${host}`);
    }
    return;
  }

  writeLog(
    "warn",
    `[external-link] blocked protocol ${protocol} (${host || linkUrl.slice(0, 80)})`,
  );
}

function sharedWebPreferences(): WebPreferences {
  return {
    preload: resolvePreloadScript(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: [`--covel-app-version=${app.getVersion()}`],
  };
}

export function createMainWindow(titleSuffix?: string): BrowserWindow {
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

  mainWindow = win;
  return win;
}

export function loadSplashInto(win: BrowserWindow): void {
  const html = buildSplashHtml();
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

export function navigateToApp(win: BrowserWindow, port: number): void {
  const url = `http://127.0.0.1:${port}/session`;
  writeLog("info", `Loading ${url}`);
  win.loadURL(url);
}
