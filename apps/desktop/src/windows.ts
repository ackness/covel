import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
  type WebPreferences,
} from "electron";
import fs from "node:fs";
import type { DiagnosedError } from "./startup-errors.js";

import { isDev, resolvePreloadScript, resolveWindowIconPath } from "./paths.js";
import {
  attachWindowStateTracking,
  resolveInitialWindowOptions,
} from "./window-state.js";
import { buildSplashHtml } from "./splash-screen.js";
import { writeLog } from "./logging.js";
import { t } from "./main-i18n.js";
import {
  appUrlOnPort,
  isAllowedSessionPermission,
  isSameStartupSplashDocument,
  isSameTrustedOrigin,
  isUntrustedAppUrl,
  loopbackHttpOrigin,
} from "./trusted-origin.js";

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Committed URL of the live main window, or undefined when closed/destroyed. */
export function getMainWindowUrl(): string | undefined {
  return mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.webContents.getURL()
    : undefined;
}

/**
 * True iff `candidateUrl` matches the main window's committed loopback
 * app origin (excluding plugin-hosted document paths).
 */
export function isTrustedFrameUrl(
  candidateUrl: string | null | undefined,
): boolean {
  return isSameTrustedOrigin(getMainWindowUrl(), candidateUrl);
}

/** Recovery-only trust for the main-process-authored data: splash document. */
export function isTrustedStartupFrameUrl(
  candidateUrl: string | null | undefined,
): boolean {
  return isSameStartupSplashDocument(getMainWindowUrl(), candidateUrl);
}

/**
 * Register fail-closed Electron session permission check and request handlers.
 * Denies every browser permission by default; allows only
 * `clipboard-sanitized-write` for the trusted main-frame app document.
 */
export function installSessionPermissionHandlers(
  targetSession: Pick<
    Electron.Session,
    "setPermissionCheckHandler" | "setPermissionRequestHandler"
  >,
): void {
  targetSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) => {
      if (!webContents || webContents !== mainWindow?.webContents) return false;
      return isAllowedSessionPermission({
        permission,
        isMainFrame: details.isMainFrame,
        requestingUrl: details.requestingUrl,
        requestingOrigin,
        trustedUrl: getMainWindowUrl(),
      });
    },
  );

  targetSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const allowed =
        webContents === mainWindow?.webContents &&
        isAllowedSessionPermission({
          permission,
          isMainFrame: details.isMainFrame,
          requestingUrl: details.requestingUrl,
          requestingOrigin: webContents.mainFrame?.origin,
          trustedUrl: getMainWindowUrl(),
        });
      if (!allowed) {
        writeLog(
          "warn",
          `[permissions] denied '${permission}' for ${details.requestingUrl || "unknown"} (mainFrame=${details.isMainFrame})`,
        );
      }
      callback(allowed);
    },
  );
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
              { role: "about" as const, label: t("menu.about") },
              { type: "separator" as const },
              {
                label: t("menu.settings"),
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
      label: t("menu.file"),
      submenu: [
        {
          label: t("menu.newWorld"),
          accelerator: "CmdOrCtrl+N",
          click: () => sendMenuAction("covel:menu:new-world"),
        },
        {
          label: t("menu.importPlugin"),
          click: () => {
            // Route through the renderer so UI can show success/error toasts.
            sendMenuAction("covel:menu:import-plugin");
          },
        },
        {
          label: t("menu.importWorld"),
          click: () => {
            sendMenuAction("covel:menu:import-world");
          },
        },
        { type: "separator" },
        {
          label: t("menu.exportChat"),
          accelerator: "CmdOrCtrl+Shift+E",
          click: () => sendMenuAction("covel:menu:export-chat"),
        },
        { type: "separator" },
        ...(!isMac
          ? [
              {
                label: t("menu.settings"),
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
      label: t("menu.edit"),
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
      label: t("menu.view"),
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom", label: t("menu.actualSize") },
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
          label: t("menu.documentation"),
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
          label: t("menu.inspectElement"),
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
 * Decide whether a `window.open()` / target=_blank / external-auth link should
 * be handed off to the system browser. HTTPS opens directly, loopback HTTP
 * opens directly (excluding untrusted plugin app paths), external HTTP requires
 * dialog confirmation, and all other schemes are blocked.
 */
export async function openExternalUrl(
  parent: BrowserWindow | null,
  linkUrl: string,
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(linkUrl);
  } catch {
    writeLog("warn", `[external-link] blocked unparseable URL: ${linkUrl}`);
    return { ok: false, reason: "invalid_url" };
  }

  const protocol = parsed.protocol;
  const host = parsed.host;

  if (protocol === "https:") {
    writeLog("info", `[external-link] https -> ${host}`);
    await shell.openExternal(linkUrl);
    return { ok: true };
  }

  if (protocol === "http:") {
    if (isUntrustedAppUrl(linkUrl)) {
      writeLog(
        "warn",
        `[external-link] blocked untrusted app path: ${linkUrl.slice(0, 120)}`,
      );
      return { ok: false, reason: "untrusted_app_path" };
    }
    if (loopbackHttpOrigin(linkUrl)) {
      writeLog("info", `[external-link] http loopback -> ${host}`);
      await shell.openExternal(linkUrl);
      return { ok: true };
    }
    if (!parent || parent.isDestroyed()) {
      writeLog(
        "warn",
        `[external-link] blocked external http without parent window: ${host}`,
      );
      return { ok: false, reason: "missing_parent_window" };
    }

    const choice = dialog.showMessageBoxSync(parent, {
      type: "warning",
      buttons: [t("dialog.open"), t("dialog.cancel")],
      defaultId: 1,
      cancelId: 1,
      title: t("dialog.externalLink.title"),
      message: t("dialog.externalLink.message", { host }),
      detail: t("dialog.externalLink.detail", { url: linkUrl }),
    });
    if (choice === 0) {
      writeLog("info", `[external-link] http (user-confirmed) -> ${host}`);
      await shell.openExternal(linkUrl);
      return { ok: true };
    }
    writeLog("info", `[external-link] http (user-cancelled) -> ${host}`);
    return { ok: false, reason: "cancelled" };
  }

  writeLog(
    "warn",
    `[external-link] blocked protocol ${protocol} (${host || linkUrl.slice(0, 80)})`,
  );
  return { ok: false, reason: "blocked_protocol" };
}

function handleExternalLinkRequest(
  parent: BrowserWindow,
  linkUrl: string,
): void {
  void openExternalUrl(parent, linkUrl);
}

function sharedWebPreferences(): WebPreferences {
  return {
    preload: resolvePreloadScript(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

/** The colours of the page under the window buttons, as `#rrggbb`. */
export interface TitleBarColors {
  readonly background: string;
  readonly foreground: string;
}

/** The splash follows the system colour scheme; these are its colours. */
function splashTitleBarColors(): TitleBarColors {
  return nativeTheme.shouldUseDarkColors
    ? { background: "#09090b", foreground: "#fafafa" }
    : { background: "#fafafa", foreground: "#09090b" };
}

/**
 * Windows paints the window buttons itself, in colours it has to be given.
 * No other platform has that overlay, and Electron throws without it.
 */
export function setTitleBarColors(
  win: BrowserWindow,
  colors: TitleBarColors,
): void {
  if (process.platform !== "win32" || win.isDestroyed()) return;
  win.setTitleBarOverlay({
    color: colors.background,
    symbolColor: colors.foreground,
  });
}

export function createMainWindow(titleSuffix?: string): BrowserWindow {
  const restored = resolveInitialWindowOptions();
  const icon = resolveWindowIconPath();

  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  const splashColors = splashTitleBarColors();

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
    // macOS); on Windows the WCO overlay draws controls in the colours of the
    // page under them: the splash's here, the app's once it reports them.
    titleBarStyle: isMac ? "hiddenInset" : isWin ? "hidden" : "default",
    trafficLightPosition: isMac ? { x: 16, y: 14 } : undefined,
    titleBarOverlay: isWin
      ? {
          color: splashColors.background,
          symbolColor: splashColors.foreground,
          height: 36,
        }
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

  // Pin the main frame to the app's own loopback origin. setWindowOpenHandler
  // only covers window.open/_blank — an in-window navigation (plugin UI, XSS,
  // a redirect) could otherwise land on an attacker page that then calls
  // `covelIpc` and reads raw provider keys. Block any main-frame navigation to
  // a different origin; genuine external links are handed to the system browser
  // (same policy as window.open). Programmatic loads from main (splash data:
  // URL, navigateToApp) do NOT emit will-navigate, so this never fights them.
  const guardNavigation = (
    event: Electron.Event & { isMainFrame?: boolean; url?: string },
    targetUrl?: string,
    _isInPlace?: boolean,
    isMainFrame?: boolean,
  ): void => {
    const isMain =
      typeof isMainFrame === "boolean"
        ? isMainFrame
        : typeof event.isMainFrame === "boolean"
          ? event.isMainFrame
          : true;
    if (!isMain) return; // subframe nav is left to CSP
    const destination = targetUrl ?? event.url ?? "";
    if (isSameTrustedOrigin(win.webContents.getURL(), destination)) return;
    event.preventDefault();
    writeLog(
      "warn",
      `[navigation] blocked main-frame navigation → ${destination.slice(0, 120)}`,
    );
    if (isUntrustedAppUrl(destination)) return;
    handleExternalLinkRequest(win, destination);
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  mainWindow = win;
  return win;
}

export function loadSplashInto(win: BrowserWindow): Promise<void> {
  // The app may have set the colours of its theme; the splash has its own.
  setTitleBarColors(win, splashTitleBarColors());
  const html = buildSplashHtml();
  return win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  );
}

/**
 * Point the window at the sidecar on `port`, keeping the page it shows now
 * (see {@link appUrlOnPort}). Loading the address the window is already on
 * reloads it, which is what a sidecar restarted on its old port needs.
 */
export function navigateToApp(win: BrowserWindow, port: number): void {
  const url = appUrlOnPort(win.webContents.getURL(), port);
  // The query can carry a session id; the log keeps to the page.
  writeLog("info", `Loading ${url.split("?")[0]}`);
  win.loadURL(url);
}

/** Deliver the error only once the splash has registered its IPC listeners. */
export async function showStartupError(
  win: BrowserWindow,
  error: DiagnosedError & { logs: string },
): Promise<void> {
  await loadSplashInto(win);
  if (!win.isDestroyed()) win.webContents.send("covel:startup:error", error);
}
