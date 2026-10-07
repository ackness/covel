/**
 * Bridge between Electron native menus / main process and the web app.
 *
 * Channel: window.covelIpc (contextBridge, sandboxed, allowlisted).
 *
 * Safe to initialize in a browser — the IPC surface is simply absent there
 * and no listeners fire.
 */

import {
  showReloadOverlay,
  hideReloadOverlay,
} from "@/components/reload-overlay.js";

type CleanupFn = () => void;

type DesktopPlatform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd";

interface CovelIpcApi {
  readonly isDesktop: true;
  readonly platform: DesktopPlatform;
  readonly appVersion: string;
  send(channel: string, payload?: unknown): boolean;
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
  on(channel: string, handler: (payload: unknown) => void): () => void;
}

/**
 * State of the local sidecar as the desktop main process reports it:
 * `restarting` after it exited and a restart is scheduled, `down` when the
 * restarts are used up or a health check got no answer, `degraded` when a
 * health check was answered with an error, `up` when it answers again.
 */
export interface ServerStatus {
  state: "up" | "down" | "degraded" | "restarting";
  /** Restart attempts so far; absent on health-check reports. */
  attempts?: number;
  delay?: number;
}

const SERVER_STATES: ReadonlySet<string> = new Set([
  "up",
  "down",
  "degraded",
  "restarting",
]);

interface DesktopBridgeHandlers {
  onOpenSettings: () => void;
  onNewWorld: () => void;
  onExportChat: () => void;
  /**
   * Fired when the user picks Import Plugin / World from the native menu.
   * Opens the shared package installer, which validates and reports results.
   * Without a specialized handler, opens Settings.
   */
  onImportPlugin?: () => void;
  onImportWorld?: () => void;
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
// Distinguishes self-host setups with ~/.covel present from pure web-tier
// deployments where file-manager / config.toml mutation are meaningless.
let restDesktopCapable = false;
let restDesktopModeKnown = false;

export type DesktopMode = "desktop" | "web" | "unknown";

// Per-launch bearer token for privileged REST writes. Sourced from the
// Electron IPC `covel:get-info` response. On pure web / dev, no token is set
// — the server-side guard also stays open in that case, so the absence is
// consistent on both ends.
let desktopRestToken: string | null = null;

/** Headers to merge into fetches that hit `/api/config/{keys,settings,data-root,open-folder}`. */
export function getDesktopRestAuthHeaders(): Record<string, string> {
  return desktopRestToken
    ? { Authorization: `Bearer ${desktopRestToken}` }
    : {};
}

async function ensureDesktopRestToken(): Promise<void> {
  if (desktopRestToken) return;
  const ipc = getCovelIpc();
  if (!ipc) return;
  try {
    const info = (await ipc.invoke("covel:get-info")) as { restToken?: string };
    if (info?.restToken) desktopRestToken = info.restToken;
  } catch {
    // Token absence is non-fatal — the server-side guard treats missing token
    // env as "no enforcement", so dev/web flows still work.
  }
}

/**
 * Discover desktop administration capabilities. This does not select the
 * settings backend: only an Electron IPC bridge uses personal files.
 * Unknown means discovery failed and may be retried later.
 */
export async function probeDesktopMode(): Promise<DesktopMode> {
  // Always try to seed the desktop REST token first — the IPC bridge has it
  // even when restDesktopCapable was already true.
  await ensureDesktopRestToken();
  if (getCovelIpc()) return "desktop";
  if (restDesktopModeKnown) return restDesktopCapable ? "desktop" : "web";
  try {
    const res = await fetch("/api/config/info", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const info = (await res.json()) as { isDesktop?: unknown };
      if (typeof info?.isDesktop === "boolean") {
        restDesktopCapable = info.isDesktop;
        restDesktopModeKnown = true;
        return info.isDesktop ? "desktop" : "web";
      }
    }
  } catch {
    // Management discovery may be retried independently of local settings.
  }
  return "unknown";
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

export function initDesktopBridge(handlers: DesktopBridgeHandlers): CleanupFn {
  const cleanups: CleanupFn[] = [];
  const ipc = getCovelIpc();

  // Preferred path: secure contextBridge channels.
  if (ipc) {
    cleanups.push(
      ipc.on(IPC_CHANNELS.openSettings, () => handlers.onOpenSettings()),
    );
    cleanups.push(ipc.on(IPC_CHANNELS.newWorld, () => handlers.onNewWorld()));
    cleanups.push(
      ipc.on(IPC_CHANNELS.exportChat, () => handlers.onExportChat()),
    );
    cleanups.push(
      ipc.on(IPC_CHANNELS.importPlugin, () => {
        if (handlers.onImportPlugin) handlers.onImportPlugin();
        else handlers.onOpenSettings();
      }),
    );
    cleanups.push(
      ipc.on(IPC_CHANNELS.importWorld, () => {
        if (handlers.onImportWorld) handlers.onImportWorld();
        else handlers.onOpenSettings();
      }),
    );
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Follow the sidecar status the desktop main process broadcasts. Nothing is
 * delivered in a browser, where no main process watches the server. Returns
 * the unsubscribe function.
 */
export function subscribeServerStatus(
  handler: (status: ServerStatus) => void,
): CleanupFn {
  const ipc = getCovelIpc();
  if (!ipc) return () => {};
  return ipc.on(IPC_CHANNELS.serverStatus, (payload) => {
    const state = (payload as { state?: unknown } | null)?.state;
    if (typeof state !== "string" || !SERVER_STATES.has(state)) return;
    handler(payload as ServerStatus);
  });
}

async function desktopConfigFetch(
  path: string,
  init: { method: "POST" | "PUT"; body: Record<string, unknown> },
): Promise<Response> {
  const res = await fetch(path, {
    method: init.method,
    headers: desktopJsonHeaders(),
    body: JSON.stringify(init.body),
  });
  if (!res.ok) {
    throw new Error(await desktopRestErrorMessage(res));
  }
  return res;
}

async function desktopConfigRequest(
  path: string,
  init: { method: "POST" | "PUT"; body: Record<string, unknown> },
): Promise<void> {
  await desktopConfigFetch(path, init);
}

function desktopJsonHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...getDesktopRestAuthHeaders(),
  };
}

async function desktopRestErrorMessage(res: Response): Promise<string> {
  const err = await res.json().catch(() => null);
  if (err && typeof err === "object" && "error" in err) {
    const message = (err as { error?: unknown }).error;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return res.statusText || `HTTP ${res.status}`;
}

type OpenFolderTarget = "config" | "data" | "logs" | "llm.toml" | "keys.env";

function postOpenFolder(target: OpenFolderTarget): Promise<void> {
  return desktopConfigRequest("/api/config/open-folder", {
    method: "POST",
    body: { target },
  });
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

/**
 * Open the active `llm.toml` in the platform default editor. The desktop
 * server creates the file from the built-in default when it does not exist
 * yet and reports that through `created`.
 */
export async function openLlmToml(): Promise<{ created: boolean }> {
  const res = await desktopConfigFetch("/api/config/open-folder", {
    method: "POST",
    body: { target: "llm.toml" },
  });
  const body = (await res.json().catch(() => null)) as {
    created?: unknown;
  } | null;
  return { created: body?.created === true };
}

/** Open `~/.covel/keys.env` in the platform default editor. */
export async function openKeysEnv(): Promise<void> {
  return postOpenFolder("keys.env");
}

export type DesktopProxyMode = "direct" | "system" | "http" | "socks";

export interface DesktopProxyConfig {
  readonly mode: DesktopProxyMode;
  readonly url?: string;
  readonly effective: "direct" | "proxy" | "system";
  readonly systemAvailable: boolean;
}

export async function getDesktopProxyConfig(): Promise<DesktopProxyConfig> {
  await ensureDesktopRestToken();
  const res = await fetch("/api/config/proxy", {
    headers: getDesktopRestAuthHeaders(),
  });
  if (!res.ok) throw new Error(await desktopRestErrorMessage(res));
  return (await res.json()) as DesktopProxyConfig;
}

export async function setDesktopProxyConfig(input: {
  mode: DesktopProxyMode;
  url?: string;
}): Promise<DesktopProxyConfig> {
  await ensureDesktopRestToken();
  const res = await fetch("/api/config/proxy", {
    method: "PUT",
    headers: desktopJsonHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await desktopRestErrorMessage(res));
  return (await res.json()) as DesktopProxyConfig;
}

/**
 * Set the data_root path in `~/.covel/config.toml`.
 *
 * - Electron: native folder picker via IPC (returns picked path or null if cancelled).
 * - REST desktop (self-host with ~/.covel): caller must supply an absolute
 *   path argument; the browser has no native folder picker and the UI must
 *   present a text input + example path.
 */
export async function pickDataDir(manualPath?: string): Promise<string | null> {
  const ipc = getCovelIpc();
  if (ipc) {
    const result = await ipc.invoke<{ path: string | null }>(
      "covel:pick-data-dir",
    );
    return result?.path ?? null;
  }
  if (!manualPath) return null;
  await desktopConfigRequest("/api/config/data-root", {
    method: "PUT",
    body: { path: manualPath },
  });
  return manualPath;
}

type RestartResult =
  | { readonly ok: true; readonly port: number }
  | { readonly ok: false; readonly port: number; readonly error: string };

/**
 * Desktop-only: ask the main process to restart the backend sidecar and
 * navigate the renderer so every stateful client (SSE subscriptions, TanStack Query
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

  showReloadOverlay(opts?.message);
  try {
    const result = await ipc.invoke<RestartResult>("covel:restart-server");
    if (!result.ok) {
      throw new Error(result.error || "Sidecar restart failed");
    }
    // Main owns navigation to the new sidecar port. Reloading here would
    // race that navigation and request the old, stopped server instead.
    // The overlay stays visible through the main-process navigation.
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
