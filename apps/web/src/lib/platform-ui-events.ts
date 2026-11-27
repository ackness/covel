import { useSyncExternalStore } from "react";
import type { SessionSlashCommand } from "@covel/shared";
import { invalidateUiSpecsCache } from "@/services/api/plugin-data.js";

const MAX_OPEN_FLOATING_WINDOWS = 6;

export interface ActiveConfigFlowRequest {
  readonly pluginId: string;
  readonly flowId: string;
  readonly initial?: Record<string, unknown>;
  readonly key: number;
}

export interface ActiveAppPageRequest {
  readonly pluginId: string;
  readonly pageId: string;
}

export interface OpenFloatingWindow {
  readonly key: string;
  readonly pluginId: string;
  readonly windowId: string;
  readonly minimized: boolean;
  readonly zIndex: number;
}

export interface PlatformUiState {
  readonly activeConfigFlow: ActiveConfigFlowRequest | null;
  readonly activeAppPage: ActiveAppPageRequest | null;
  readonly openWindows: readonly OpenFloatingWindow[];
  readonly commandPaletteOpen: boolean;
  readonly instanceDataVersion: number;
  readonly activeSessionId: string | null;
  readonly activeSessionCommands: readonly SessionSlashCommand[];
  readonly pendingSettingsNavigation: {
    readonly nodeId: string;
    readonly key: number;
  } | null;
}

const INITIAL_STATE: PlatformUiState = {
  activeConfigFlow: null,
  activeAppPage: null,
  openWindows: [],
  commandPaletteOpen: false,
  instanceDataVersion: 0,
  activeSessionId: null,
  activeSessionCommands: [],
  pendingSettingsNavigation: null,
};

let state: PlatformUiState = INITIAL_STATE;
let nextFlowKey = 1;
let nextSettingsNavKey = 1;
let nextZIndex = 10;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setState(updater: (prev: PlatformUiState) => PlatformUiState): void {
  const next = updater(state);
  if (next === state) return;
  state = next;
  emit();
}

export function windowKey(pluginId: string, windowId: string): string {
  return `${pluginId}:${windowId}`;
}

export function openPluginConfigFlow(
  pluginId: string,
  flowId: string,
  initial?: Record<string, unknown>,
): void {
  setState((prev) => ({
    ...prev,
    activeConfigFlow: {
      pluginId,
      flowId,
      ...(initial !== undefined ? { initial } : {}),
      key: nextFlowKey++,
    },
  }));
}

export function closePluginConfigFlow(): void {
  setState((prev) =>
    prev.activeConfigFlow === null ? prev : { ...prev, activeConfigFlow: null },
  );
}

export function openPluginAppPage(pluginId: string, pageId: string): void {
  setState((prev) => ({
    ...prev,
    activeAppPage: { pluginId, pageId },
  }));
}

export function closePluginAppPage(): void {
  setState((prev) =>
    prev.activeAppPage === null ? prev : { ...prev, activeAppPage: null },
  );
}

export function openPluginWindow(pluginId: string, windowId: string): void {
  const key = windowKey(pluginId, windowId);
  const zIndex = nextZIndex++;
  setState((prev) => {
    const existing = prev.openWindows.find((win) => win.key === key);
    if (existing) {
      return {
        ...prev,
        openWindows: prev.openWindows.map((win) =>
          win.key === key ? { ...win, minimized: false, zIndex } : win,
        ),
      };
    }
    const base =
      prev.openWindows.length >= MAX_OPEN_FLOATING_WINDOWS
        ? [...prev.openWindows].sort((a, b) => a.zIndex - b.zIndex).slice(1)
        : prev.openWindows;
    return {
      ...prev,
      openWindows: [
        ...base,
        { key, pluginId, windowId, minimized: false, zIndex },
      ],
    };
  });
}

export function closePluginWindow(key: string): void {
  setState((prev) => {
    const next = prev.openWindows.filter((win) => win.key !== key);
    return next.length === prev.openWindows.length
      ? prev
      : { ...prev, openWindows: next };
  });
}

export function openPlatformTarget(
  pluginId: string,
  target: {
    readonly openFlow?: unknown;
    readonly openPage?: unknown;
    readonly openWindow?: unknown;
  },
): boolean {
  if (typeof target.openFlow === "string" && target.openFlow) {
    openPluginConfigFlow(pluginId, target.openFlow);
    return true;
  }
  if (typeof target.openPage === "string" && target.openPage) {
    openPluginAppPage(pluginId, target.openPage);
    return true;
  }
  if (typeof target.openWindow === "string" && target.openWindow) {
    openPluginWindow(pluginId, target.openWindow);
    return true;
  }
  return false;
}

function updatePluginWindow(
  key: string,
  updater: (win: OpenFloatingWindow, zIndex: number) => OpenFloatingWindow,
): void {
  const zIndex = nextZIndex++;
  setState((prev) => {
    const existing = prev.openWindows.find((win) => win.key === key);
    if (!existing) return prev;
    return {
      ...prev,
      openWindows: prev.openWindows.map((win) =>
        win.key === key ? updater(win, zIndex) : win,
      ),
    };
  });
}

export function focusPluginWindow(key: string): void {
  updatePluginWindow(key, (win, zIndex) => ({ ...win, zIndex }));
}

export function toggleMinimizePluginWindow(key: string): void {
  updatePluginWindow(key, (win, zIndex) => ({
    ...win,
    minimized: !win.minimized,
    zIndex,
  }));
}

export function openCommandPalette(): void {
  setState((prev) =>
    prev.commandPaletteOpen ? prev : { ...prev, commandPaletteOpen: true },
  );
}

export function closeCommandPalette(): void {
  setState((prev) =>
    !prev.commandPaletteOpen ? prev : { ...prev, commandPaletteOpen: false },
  );
}

export function toggleCommandPalette(): void {
  setState((prev) => ({
    ...prev,
    commandPaletteOpen: !prev.commandPaletteOpen,
  }));
}

export function bumpPlatformInstanceDataVersion(): void {
  invalidateUiSpecsCache();
  setState((prev) => ({
    ...prev,
    instanceDataVersion: prev.instanceDataVersion + 1,
  }));
}

export function setActiveSessionPaletteCommands(
  sessionId: string,
  commands: readonly SessionSlashCommand[],
): void {
  setState((prev) => ({
    ...prev,
    activeSessionId: sessionId,
    activeSessionCommands: commands,
  }));
}

export function clearActiveSessionPaletteCommands(sessionId: string): void {
  setState((prev) =>
    prev.activeSessionId !== sessionId
      ? prev
      : { ...prev, activeSessionId: null, activeSessionCommands: [] },
  );
}

export function requestSettingsNavigation(nodeId: string): void {
  setState((prev) => ({
    ...prev,
    pendingSettingsNavigation: { nodeId, key: nextSettingsNavKey++ },
  }));
}

export function clearSettingsNavigation(key?: number): void {
  setState((prev) => {
    if (prev.pendingSettingsNavigation === null) return prev;
    if (key !== undefined && prev.pendingSettingsNavigation.key !== key) {
      return prev;
    }
    return { ...prev, pendingSettingsNavigation: null };
  });
}

export function resetPlatformUiState(): void {
  nextFlowKey = 1;
  nextSettingsNavKey = 1;
  nextZIndex = 10;
  state = INITIAL_STATE;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PlatformUiState {
  return state;
}

export function usePlatformUiState(): PlatformUiState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
