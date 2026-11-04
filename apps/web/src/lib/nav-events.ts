/**
 * Lightweight pub/sub bridge so the global topbar nav can poke into
 * page-local state (open settings, switch right-panel tab, etc.) without
 * threading callbacks through the router or hoisting state into a context.
 *
 * Each session-shell component subscribes to the events it cares about and
 * the topbar dispatches by name.
 */

export type NavEvent =
  | "open-plugins"
  | "open-images"
  | "open-database"
  | {
      readonly type: "open-plugin-panel";
      readonly pluginId: string;
      readonly panelId: string;
    };

type Listener = (event: NavEvent) => void;

export type SessionPanel = "plugins" | "images";
export interface RightPanelRequest {
  readonly event: Exclude<NavEvent, "open-plugins">;
}

const listeners = new Set<Listener>();

export function emitNavEvent(event: NavEvent): void {
  for (const listener of listeners) listener(event);
}

export function onNavEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const worldListListeners = new Set<() => void>();

/**
 * The topbar's World item, pressed while the world screen is already shown:
 * the route does not change, so the screen leaves its detail or editor view
 * itself (the editor asks first when it has unsaved changes).
 */
export function emitWorldListRequest(): void {
  for (const listener of worldListListeners) listener();
}

export function onWorldListRequest(listener: () => void): () => void {
  worldListListeners.add(listener);
  return () => {
    worldListListeners.delete(listener);
  };
}

/** Returns true when it opened the dialog. */
export type SettingsRequestListener = (key?: string) => boolean;
const settingsListeners = new Set<SettingsRequestListener>();
let pendingSettingsRequest: { readonly key?: string } | null = null;

/**
 * The topbar's Settings item. The dialog lives with whichever screen is shown,
 * so a request nobody handled yet waits for the next screen to mount (the
 * debugger has no dialog of its own).
 */
export function emitSettingsRequest(key?: string): void {
  let handled = false;
  for (const listener of settingsListeners) handled = listener(key) || handled;
  const pending = handled ? null : { key };
  pendingSettingsRequest = pending;
  // A request nobody picks up soon is stale; do not open settings much later.
  if (pending)
    setTimeout(() => {
      if (pendingSettingsRequest === pending) pendingSettingsRequest = null;
    }, 3000);
}

export function onSettingsRequest(
  listener: SettingsRequestListener,
): () => void {
  settingsListeners.add(listener);
  const pending = pendingSettingsRequest;
  if (pending && listener(pending.key)) pendingSettingsRequest = null;
  return () => {
    settingsListeners.delete(listener);
  };
}
