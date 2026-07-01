/**
 * Preload script — runs in an isolated world with access to both Node APIs
 * and the DOM. It is the single bridge between the main process and the
 * web app running in the sandboxed renderer.
 *
 * Exposes a typed `window.covelIpc` surface via contextBridge. The renderer
 * can only call the allowlisted channels defined below.
 */

import { contextBridge, ipcRenderer } from "electron";

/** Channels the renderer may INVOKE (request/response) on main. */
const INVOKE_CHANNELS = [
  "covel:get-info",
  "covel:retry-startup",
  "covel:open-logs-dir",
  "covel:open-config-dir",
  "covel:open-data-dir",
  "covel:pick-data-dir",
  "covel:restart-server",
  "covel:keys:load",
  "covel:keys:save",
  "covel:settings:load",
  "covel:settings:save",
  "covel:import:plugin",
  "covel:import:world",
  "covel:import:pick-plugin",
  "covel:import:pick-world",
] as const;

/** Channels main may emit TO the renderer. Renderer can subscribe to any of these. */
const RECEIVE_CHANNELS = [
  "covel:menu:open-settings",
  "covel:menu:new-world",
  "covel:menu:export-chat",
  "covel:menu:import-plugin",
  "covel:menu:import-world",
  "covel:server:status",
  "covel:startup:progress",
  "covel:startup:error",
] as const;

type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
type ReceiveChannel = (typeof RECEIVE_CHANNELS)[number];

function isInvokeChannel(ch: string): ch is InvokeChannel {
  return (INVOKE_CHANNELS as readonly string[]).includes(ch);
}

function isReceiveChannel(ch: string): ch is ReceiveChannel {
  return (RECEIVE_CHANNELS as readonly string[]).includes(ch);
}

// Auto-expire listeners when the page is reloaded so we don't leak.
const activeListeners = new Set<{
  channel: string;
  listener: (...args: unknown[]) => void;
}>();

window.addEventListener("beforeunload", () => {
  for (const { channel, listener } of activeListeners) {
    ipcRenderer.removeListener(channel, listener);
  }
  activeListeners.clear();
});

const api = {
  /** True if running inside Electron. Renderer uses this to gate desktop-only UI. */
  isDesktop: true,

  /** Platform identifier (darwin, win32, linux). */
  platform: process.platform,

  /** Short app version string. Set at preload time via env var injection. */
  appVersion: process.env.COVEL_APP_VERSION ?? "0.0.1-beta",

  /**
   * Request/response. Rejects if the channel is not allowlisted.
   */
  async invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
    if (!isInvokeChannel(channel)) {
      throw new Error(`[covelIpc] blocked invoke to '${channel}'`);
    }
    return (await ipcRenderer.invoke(channel, payload)) as T;
  },

  /**
   * Subscribe to a channel. Returns an unsubscribe function.
   * Listener receives the payload (event object is hidden for security).
   */
  on(channel: string, handler: (payload: unknown) => void): () => void {
    if (!isReceiveChannel(channel)) {
      console.warn(`[covelIpc] blocked subscription to '${channel}'`);
      return () => {};
    }
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, listener);
    const entry = { channel, listener: listener as (...a: unknown[]) => void };
    activeListeners.add(entry);
    return () => {
      ipcRenderer.removeListener(channel, listener);
      activeListeners.delete(entry);
    };
  },
} as const;

contextBridge.exposeInMainWorld("covelIpc", api);

export type CovelIpcApi = typeof api;
