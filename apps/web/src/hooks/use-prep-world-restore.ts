import { useEffect, useRef } from "react";

const PREP_WORLD_KEY = "covel:prep-world";

function read(): string | null {
  try {
    return sessionStorage.getItem(PREP_WORLD_KEY);
  } catch {
    return null;
  }
}

function write(worldId: string | null): void {
  try {
    if (worldId) sessionStorage.setItem(PREP_WORLD_KEY, worldId);
    else sessionStorage.removeItem(PREP_WORLD_KEY);
  } catch {
    // Without storage a reload returns to the world list, as before.
  }
}

/** Whether this page load is a reload of the tab (not a new navigation). */
function pageWasReloaded(): boolean {
  try {
    const [entry] = performance.getEntriesByType("navigation");
    return (
      (entry as PerformanceNavigationTiming | undefined)?.type === "reload"
    );
  } catch {
    return false;
  }
}

/**
 * Keep the session-prep screen across a reload of the tab. The prep screen is
 * not in the URL, so the world being prepared is remembered for this tab and
 * selected again once the app has booted. Opening the app anew starts on
 * the world list, and a session in the URL wins.
 */
export function usePrepWorldRestore({
  booted,
  sid,
  worlds,
  prepWorldId,
  inSession,
  selectWorld,
  reloaded = pageWasReloaded(),
}: {
  readonly booted: boolean;
  readonly sid: string | undefined;
  readonly worlds: readonly { readonly id: string }[];
  readonly prepWorldId: string | undefined;
  readonly inSession: boolean;
  readonly selectWorld: (worldId: string) => void;
  /** Defaults to what the browser reports for this page load. */
  readonly reloaded?: boolean;
}): void {
  const restored = useRef(false);
  useEffect(() => {
    if (!booted || restored.current) return;
    restored.current = true;
    const remembered = read();
    if (
      reloaded &&
      !sid &&
      !prepWorldId &&
      remembered &&
      worlds.some((world) => world.id === remembered)
    )
      selectWorld(remembered);
  }, [booted, reloaded, sid, prepWorldId, worlds, selectWorld]);
  useEffect(() => {
    if (!booted || !restored.current) return;
    write(prepWorldId && !inSession ? prepWorldId : null);
  }, [booted, prepWorldId, inSession]);
}
