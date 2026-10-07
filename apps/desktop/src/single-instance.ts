/**
 * One running Covel per user. A second copy would start a second sidecar on
 * the same database, and the SQLite session locks only exist inside one
 * process: both sidecars could then advance the same session.
 *
 * Kept free of any Electron import so the decision stays unit-testable.
 */

export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: () => void): unknown;
}

export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * Take the instance lock. `false` means another Covel already holds it: the
 * caller must quit without starting anything. The holder brings its window
 * forward each time a later launch is turned away, so the launch the player
 * just made still ends on a visible Covel window.
 */
export function claimSingleInstance(
  app: SingleInstanceApp,
  getWindow: () => FocusableWindow | null,
): boolean {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  return true;
}
