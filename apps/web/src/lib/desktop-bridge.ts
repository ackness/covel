/**
 * Bridge between Electron native menus and the web app.
 *
 * Electron dispatches CustomEvents on `window` when menu items are clicked.
 * This module registers listeners that translate those events into app-level
 * actions (router navigation, dialog opens, etc.).
 *
 * Safe to initialize in any environment -- the events are never fired in a
 * regular browser, so there is no overhead.
 */

type CleanupFn = () => void;

export function initDesktopBridge(handlers: {
  onOpenSettings: () => void;
  onNewWorld: () => void;
  onExportChat: () => void;
}): CleanupFn {
  const listeners: Array<[string, EventListener]> = [
    [
      "covel:open-settings",
      () => handlers.onOpenSettings(),
    ],
    [
      "covel:new-world",
      () => handlers.onNewWorld(),
    ],
    [
      "covel:export-chat",
      () => handlers.onExportChat(),
    ],
  ];

  for (const [event, handler] of listeners) {
    window.addEventListener(event, handler);
  }

  return () => {
    for (const [event, handler] of listeners) {
      window.removeEventListener(event, handler);
    }
  };
}
