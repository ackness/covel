/**
 * Persist and restore BrowserWindow size, position, and maximized/fullscreen state.
 *
 * Stored as JSON at `<userData>/window-state.json`. Simpler than
 * `electron-window-state` for our needs: one window, small surface.
 *
 * Design choices:
 *   - Debounce writes (250 ms) so rapid resizes don't hammer the disk.
 *   - Ignore restored geometry that puts the window offscreen (e.g. monitor
 *     disconnected) — fall back to defaults.
 *   - Persist maximized/fullscreen flags separately from geometry, so we
 *     restore the *outer* state and the OS fills in the inner bounds.
 */

import { BrowserWindow, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { covelHome } from "./paths.js";

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isFullScreen: boolean;
}

const DEFAULT_STATE: WindowState = {
  width: 1440,
  height: 900,
  isMaximized: false,
  isFullScreen: false,
};

const STATE_VERSION = 1;
const DEBOUNCE_MS = 250;

interface Persisted {
  version: number;
  state: WindowState;
}

function stateFile(): string {
  return path.join(covelHome(), "window-state.json");
}

function readPersisted(): WindowState {
  try {
    const raw = fs.readFileSync(stateFile(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    if (parsed.version !== STATE_VERSION || !parsed.state) {
      return DEFAULT_STATE;
    }
    return { ...DEFAULT_STATE, ...parsed.state };
  } catch {
    return DEFAULT_STATE;
  }
}

function writePersisted(state: WindowState): void {
  try {
    const payload: Persisted = { version: STATE_VERSION, state };
    fs.writeFileSync(stateFile(), JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.warn("[window-state] write failed:", err);
  }
}

/** Return true if (x, y, width, height) intersects any connected display. */
function isOnScreen(x: number, y: number, w: number, h: number): boolean {
  const displays = screen.getAllDisplays();
  return displays.some((d) => {
    const b = d.bounds;
    return (
      x + w > b.x &&
      y + h > b.y &&
      x < b.x + b.width &&
      y < b.y + b.height
    );
  });
}

export interface RestoredWindowOptions {
  x?: number;
  y?: number;
  width: number;
  height: number;
  initial: {
    maximize: boolean;
    fullScreen: boolean;
  };
}

/** Read the persisted state and produce BrowserWindow constructor options. */
export function resolveInitialWindowOptions(): RestoredWindowOptions {
  const state = readPersisted();
  const onScreen =
    state.x !== undefined &&
    state.y !== undefined &&
    isOnScreen(state.x, state.y, state.width, state.height);

  return {
    x: onScreen ? state.x : undefined,
    y: onScreen ? state.y : undefined,
    width: state.width,
    height: state.height,
    initial: {
      maximize: state.isMaximized,
      fullScreen: state.isFullScreen,
    },
  };
}

/**
 * Attach listeners so that the window's state is saved on resize/move and
 * maximize/fullscreen transitions. Call once per window.
 */
export function attachWindowStateTracking(win: BrowserWindow): void {
  let writeTimer: NodeJS.Timeout | null = null;

  const snapshot = (): WindowState => {
    // When maximized/fullscreen we keep the last NORMAL bounds so the
    // window restores to a reasonable size when the user un-maximizes.
    const isMaximized = win.isMaximized();
    const isFullScreen = win.isFullScreen();
    const bounds =
      isMaximized || isFullScreen ? win.getNormalBounds() : win.getBounds();
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized,
      isFullScreen,
    };
  };

  const schedule = (): void => {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      writePersisted(snapshot());
    }, DEBOUNCE_MS);
  };

  // Electron 41+ typedef moved each event name onto its own BrowserWindow.on
  // overload, so a union type loses the call signature match. Listing the
  // events explicitly keeps TypeScript happy without casts.
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("enter-full-screen", schedule);
  win.on("leave-full-screen", schedule);

  win.on("close", () => {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    writePersisted(snapshot());
  });
}
