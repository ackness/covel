/**
 * Bridge between Electron native menus / main process and the web app.
 *
 * Primary channel: window.covelIpc (contextBridge, sandboxed, allowlisted).
 * Fallback: window CustomEvent for older main-process versions that still
 * dispatch via executeJavaScript.
 *
 * Safe to initialize in a browser — the IPC surface is simply absent there
 * and no listeners fire.
 */

type CleanupFn = () => void;

type DesktopPlatform =
  | "aix" | "android" | "darwin" | "freebsd" | "haiku"
  | "linux" | "openbsd" | "sunos" | "win32" | "cygwin" | "netbsd";

interface CovelIpcApi {
  readonly isDesktop: true;
  readonly platform: DesktopPlatform;
  readonly appVersion: string;
  send(channel: string, payload?: unknown): boolean;
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
  on(channel: string, handler: (payload: unknown) => void): () => void;
}

interface ServerStatus {
  state: "up" | "down" | "degraded" | "restarting";
  attempts?: number;
  delay?: number;
}

interface DesktopBridgeHandlers {
  onOpenSettings: () => void;
  onNewWorld: () => void;
  onExportChat: () => void;
  /**
   * Fired when the user picks Import Plugin / World from the native menu.
   * If not supplied, the bridge falls back to invoking the native picker
   * + import flow directly and dispatches a `covel:import:complete`
   * CustomEvent so page components can refresh their lists.
   */
  onImportPlugin?: () => void;
  onImportWorld?: () => void;
  onServerStatus?: (status: ServerStatus) => void;
}

declare global {
  interface Window {
    covelIpc?: CovelIpcApi;
  }
}

export function getCovelIpc(): CovelIpcApi | null {
  if (typeof window === "undefined") return null;
  return window.covelIpc ?? null;
}

// REST-mode desktop capability — set by probeDesktopMode() at app boot.
// Distinguishes "Tauri webview / self-host with ~/.covel present" from pure
// web-tier deployments where file-manager / config.toml mutation are
// meaningless.
let restDesktopCapable = false;

/**
 * Detect whether the server thinks we're running as a desktop deployment
 * (i.e. it has access to `~/.covel/`). Call once at boot; cheap to re-call
 * (it skips the network probe after the first success).
 */
export async function probeDesktopMode(): Promise<void> {
  if (getCovelIpc() || restDesktopCapable) return;
  try {
    const res = await fetch("/api/config/info");
    if (res.ok) {
      const info = (await res.json()) as { isDesktop?: boolean };
      restDesktopCapable = !!info.isDesktop;
    }
  } catch {
    // Non-fatal. Leave restDesktopCapable at false.
  }
}

/**
 * True when desktop-only features (folder pickers, data_root editing) are
 * available — either via Electron IPC or the server's desktop-REST surface.
 */
export function isDesktopApp(): boolean {
  return getCovelIpc() !== null || restDesktopCapable;
}

/** True specifically for the IPC branch (Electron). */
export function hasElectronIpc(): boolean {
  return getCovelIpc() !== null;
}

const IPC_CHANNELS = {
  openSettings: "covel:menu:open-settings",
  newWorld: "covel:menu:new-world",
  exportChat: "covel:menu:export-chat",
  importPlugin: "covel:menu:import-plugin",
  importWorld: "covel:menu:import-world",
  serverStatus: "covel:server:status",
} as const;

const LEGACY_EVENTS: Record<string, keyof typeof IPC_CHANNELS> = {
  "covel:open-settings": "openSettings",
  "covel:new-world": "newWorld",
  "covel:export-chat": "exportChat",
};

export function initDesktopBridge(handlers: DesktopBridgeHandlers): CleanupFn {
  const cleanups: CleanupFn[] = [];
  const ipc = getCovelIpc();

  // Preferred path: secure contextBridge channels.
  if (ipc) {
    cleanups.push(ipc.on(IPC_CHANNELS.openSettings, () => handlers.onOpenSettings()));
    cleanups.push(ipc.on(IPC_CHANNELS.newWorld, () => handlers.onNewWorld()));
    cleanups.push(ipc.on(IPC_CHANNELS.exportChat, () => handlers.onExportChat()));
    const defaultImportHandler = (kind: ImportKind) => async () => {
      try {
        const result = await pickAndImport(kind);
        if (result) {
          window.dispatchEvent(
            new CustomEvent("covel:import:complete", { detail: result }),
          );
        }
      } catch (err) {
        console.warn(`[desktop-bridge] import ${kind} failed:`, err);
      }
    };
    cleanups.push(
      ipc.on(IPC_CHANNELS.importPlugin, () => {
        if (handlers.onImportPlugin) handlers.onImportPlugin();
        else void defaultImportHandler("plugin")();
      }),
    );
    cleanups.push(
      ipc.on(IPC_CHANNELS.importWorld, () => {
        if (handlers.onImportWorld) handlers.onImportWorld();
        else void defaultImportHandler("world")();
      }),
    );
    if (handlers.onServerStatus) {
      cleanups.push(
        ipc.on(IPC_CHANNELS.serverStatus, (payload) => {
          handlers.onServerStatus?.(payload as ServerStatus);
        }),
      );
    }
  }

  // Legacy CustomEvent fallback (kept one release for backwards compat).
  const legacyListeners: Array<[string, EventListener]> = [];
  for (const [eventName, handlerKey] of Object.entries(LEGACY_EVENTS)) {
    const listener: EventListener = () => {
      switch (handlerKey) {
        case "openSettings":
          handlers.onOpenSettings();
          break;
        case "newWorld":
          handlers.onNewWorld();
          break;
        case "exportChat":
          handlers.onExportChat();
          break;
      }
    };
    window.addEventListener(eventName, listener);
    legacyListeners.push([eventName, listener]);
  }
  cleanups.push(() => {
    for (const [event, handler] of legacyListeners) {
      window.removeEventListener(event, handler);
    }
  });

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

async function postOpenFolder(target: "config" | "data" | "logs"): Promise<void> {
  const res = await fetch("/api/config/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

export async function openLogsDir(): Promise<void> {
  const ipc = getCovelIpc();
  if (ipc) return void ipc.invoke("covel:open-logs-dir");
  return postOpenFolder("logs");
}

export async function openConfigDir(): Promise<void> {
  const ipc = getCovelIpc();
  if (ipc) return void ipc.invoke("covel:open-config-dir");
  return postOpenFolder("config");
}

export async function openDataDir(): Promise<void> {
  const ipc = getCovelIpc();
  if (ipc) return void ipc.invoke("covel:open-data-dir");
  return postOpenFolder("data");
}

/** Open `~/.covel/llm.toml` in the platform default editor. */
export async function openLlmToml(): Promise<void> {
  const res = await fetch("/api/config/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: "llm.toml" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

/** Open `~/.covel/keys.env` in the platform default editor. */
export async function openKeysEnv(): Promise<void> {
  const res = await fetch("/api/config/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: "keys.env" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

/**
 * Set the data_root path in `~/.covel/config.toml`.
 *
 * - Electron: native folder picker via IPC (returns picked path or null if cancelled).
 * - REST desktop (Tauri, self-host with ~/.covel): caller must supply an
 *   absolute path argument; the browser has no native folder picker and the
 *   UI must present a text input + example path.
 */
export async function pickDataDir(manualPath?: string): Promise<string | null> {
  const ipc = getCovelIpc();
  if (ipc) {
    const result = await ipc.invoke<{ path: string | null }>("covel:pick-data-dir");
    return result?.path ?? null;
  }
  if (!manualPath) return null;
  const res = await fetch("/api/config/data-root", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: manualPath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return manualPath;
}

/** Convenience helper: restart the backend server. */
export async function restartServer(): Promise<{ port: number } | null> {
  const ipc = getCovelIpc();
  if (!ipc) return null;
  return ipc.invoke<{ port: number }>("covel:restart-server");
}

/**
 * Desktop-only: restart the backend sidecar and then hard-reload the
 * renderer so every stateful client (SSE subscriptions, TanStack Query
 * caches, plugin UI specs, session-store, Error banners) rebuilds against
 * the fresh process.
 *
 * Shows the global `<ReloadOverlay />` for the duration (main-process
 * IPC blocks until the sidecar's /api/health passes, typically 2–5s).
 *
 * Returns `false` if not running inside a desktop shell — callers can
 * fall back to instructing the user to refresh manually.
 */
export async function reloadServerAndWait(opts?: {
  message?: string;
}): Promise<boolean> {
  const ipc = getCovelIpc();
  if (!ipc) return false;

  const { showReloadOverlay, hideReloadOverlay } = await import(
    "@/components/reload-overlay.js"
  );

  showReloadOverlay(opts?.message);
  try {
    await ipc.invoke<{ port: number }>("covel:restart-server");
    // Sidecar is healthy again; reload the page so all clients rebuild
    // cleanly. The overlay stays visible through the navigation.
    window.location.reload();
    return true;
  } catch (err) {
    hideReloadOverlay();
    throw err;
  }
}

/**
 * Retrieve runtime info. Electron returns the full set via IPC; REST-mode
 * desktop falls back to `/api/config/info` which returns the paths but not
 * the Electron-only fields (version, platform, serverPort).
 */
export async function getDesktopInfo(): Promise<{
  version: string;
  platform: string;
  isDev: boolean;
  covelHome: string;
  dataRoot: string;
  logsDir: string;
  dbPath: string;
  configTomlPath: string;
  llmTomlPath: string;
  keysEnvPath: string;
  serverPort: number;
} | null> {
  const ipc = getCovelIpc();
  if (ipc) return ipc.invoke("covel:get-info");

  // REST fallback — populate unknowns with placeholders so consumers can
  // render without null-checks for each field.
  try {
    const res = await fetch("/api/config/info");
    if (!res.ok) return null;
    const info = (await res.json()) as {
      isDesktop?: boolean;
      covelHome?: string | null;
      dataRoot?: string | null;
      dbPath?: string | null;
      logsDir?: string | null;
      llmTomlPath?: string | null;
      keysEnvPath?: string | null;
    };
    if (!info.isDesktop) return null;
    return {
      version: "—",
      platform: "web",
      isDev: false,
      covelHome: info.covelHome ?? "",
      dataRoot: info.dataRoot ?? "",
      logsDir: info.logsDir ?? "",
      dbPath: info.dbPath ?? "",
      configTomlPath: info.covelHome ? `${info.covelHome}/config.toml` : "",
      llmTomlPath: info.llmTomlPath ?? "",
      keysEnvPath: info.keysEnvPath ?? "",
      serverPort: 0,
    };
  } catch {
    return null;
  }
}

// ── Asset import ──────────────────────────────────────────────────

export type ImportKind = "plugin" | "world";

export interface ImportResult {
  readonly ok: boolean;
  readonly kind: ImportKind;
  readonly targetPath?: string;
  readonly itemName?: string;
  readonly message?: string;
}

/** Import an asset from a known filesystem path (drag-drop target). */
export async function importAssetFromPath(
  kind: ImportKind,
  sourcePath: string,
): Promise<ImportResult | null> {
  const ipc = getCovelIpc();
  if (!ipc) return null;
  return ipc.invoke<ImportResult>(`covel:import:${kind}`, { sourcePath });
}

/** Open the native file chooser and import the selected file / folder. */
export async function pickAndImport(kind: ImportKind): Promise<ImportResult | null> {
  const ipc = getCovelIpc();
  if (!ipc) return null;
  return ipc.invoke<ImportResult>(`covel:import:pick-${kind}`);
}
