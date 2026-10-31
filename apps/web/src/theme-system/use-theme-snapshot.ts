import { getSettings } from "@/settings/store.js";
import {
  currentPluginThemeSession,
  effectivePluginPalette,
  pluginThemeRevision,
  subscribePluginThemes,
} from "./plugin-themes.js";
import { useSyncExternalStore, useCallback, useMemo } from "react";

/**
 * The part of the active style scheme a plugin's own widget can use. A widget
 * runs in a sandboxed frame where the host's stylesheet does not reach, so the
 * values are read here and handed over as plain strings.
 */
const TOKEN_SOURCES = {
  background: "--surface-page",
  surface: "--surface-elevated",
  foreground: "--color-foreground",
  mutedForeground: "--color-muted-foreground",
  border: "--color-border",
  accent: "--accent-primary",
  accentForeground: "--color-primary-foreground",
  success: "--accent-success",
  warning: "--accent-warning",
  danger: "--accent-danger",
  radiusControl: "--radius-control",
  radiusCard: "--radius-card",
  fontSans: "--font-sans",
  fontSerif: "--font-serif",
  fontDisplay: "--font-display",
} as const;

export type ThemeTokenName = keyof typeof TOKEN_SOURCES;

export interface ThemeSnapshot {
  /** Theme package ID, e.g. `panel`. */
  readonly id: string;
  readonly scheme: "light" | "dark";
  readonly tokens: Readonly<Record<ThemeTokenName, string>>;
}

function read(): ThemeSnapshot {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const tokens = Object.fromEntries(
    Object.entries(TOKEN_SOURCES).map(([name, property]) => [
      name,
      style.getPropertyValue(property).trim(),
    ]),
  ) as Record<ThemeTokenName, string>;
  return {
    id: root.getAttribute("data-theme") ?? "",
    scheme: root.getAttribute("data-scheme") === "light" ? "light" : "dark",
    tokens,
  };
}

let snapshot: ThemeSnapshot | undefined;
let serialized = "";
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function refresh(): void {
  const next = read();
  const text = JSON.stringify(next);
  // Keep the same object while nothing changed, so subscribers do not re-render.
  if (text === serialized) return;
  serialized = text;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer && typeof MutationObserver !== "undefined") {
    // Switching a theme changes attributes on <html>; editing a custom theme
    // rewrites its <style> in <head>.
    observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-scheme", "class", "style"],
    });
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}

function current(): ThemeSnapshot {
  if (!snapshot) {
    snapshot = read();
    serialized = JSON.stringify(snapshot);
  }
  return snapshot;
}

/** The active theme's id, colour scheme and a fixed set of resolved tokens. */
export function useThemeSnapshot(sessionId?: string): ThemeSnapshot {
  const base = useSyncExternalStore(subscribe, current, current);
  const store = sessionId ? getSettings() : undefined;
  const listen = useCallback(
    (listener: () => void) =>
      store ? subscribePluginThemes(store, listener) : () => {},
    [store],
  );
  const revision = useCallback(
    () => (store ? pluginThemeRevision(store) : 0),
    [store],
  );
  const version = useSyncExternalStore(listen, revision, revision);
  return useMemo(() => {
    const source =
      store && sessionId
        ? currentPluginThemeSession(store, sessionId)?.state.effective
        : undefined;
    if (!source || !store) return base;
    const palette = effectivePluginPalette(store, source.theme);
    return {
      ...base,
      id: `plugin:${source.pluginId}:${source.themeId}:${source.contentHash}`,
      tokens: Object.fromEntries(
        Object.entries(TOKEN_SOURCES).map(([name, property]) => [
          name,
          palette[property] ?? base.tokens[name as ThemeTokenName],
        ]),
      ) as Record<ThemeTokenName, string>,
    };
  }, [base, store, sessionId, version]);
}
