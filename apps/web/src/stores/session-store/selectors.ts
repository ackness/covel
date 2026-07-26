import type { SessionRecord } from "@/services/api.js";
import type { SessionState } from "./types.js";

/**
 * The session exists but no turn has completed — the player is still on the
 * "begin adventure" hero and the setup runtimes have not run yet.
 *
 * Shared so the hero and the composer agree on what "not started" means: they
 * are two halves of one rule, and a drift between them lets the player type
 * into a world that has no character or opening scene.
 */
export function isPreGameSession(
  session: SessionRecord | null | undefined,
): boolean {
  return session?.status === "active" && session.turnCount === 0;
}

export function selectSessionId(state: SessionState): string | null {
  return state.session?.id ?? null;
}

export function canRunSessionAction(state: SessionState): boolean {
  return state.session?.status === "active" && !state.executing;
}
