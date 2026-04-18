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

/** True if running inside Electron. */
export function isDesktopApp(): boolean {
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

/** Convenience helper: ask the main process to open the logs folder. */
export async function openLogsDir(): Promise<void> {
  const ipc = getCovelIpc();
  if (!ipc) return;
  await ipc.invoke("covel:open-logs-dir");
}

/** Convenience helper: ask the main process to open the user data folder. */
export async function openUserDataDir(): Promise<void> {
  const ipc = getCovelIpc();
  if (!ipc) return;
  await ipc.invoke("covel:open-user-data-dir");
}

/** Convenience helper: restart the backend server. */
export async function restartServer(): Promise<{ port: number } | null> {
  const ipc = getCovelIpc();
  if (!ipc) return null;
  return ipc.invoke<{ port: number }>("covel:restart-server");
}

/** Retrieve runtime info (app version, platform, paths). */
export async function getDesktopInfo(): Promise<{
  version: string;
  platform: string;
  isDev: boolean;
  userData: string;
  logsDir: string;
  dbPath: string;
  serverPort: number;
} | null> {
  const ipc = getCovelIpc();
  if (!ipc) return null;
  return ipc.invoke("covel:get-info");
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
