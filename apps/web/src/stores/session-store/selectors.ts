import type { SessionState } from "./types.js";

export function selectSessionId(state: SessionState): string | null {
  return state.session?.id ?? null;
}

export function canRunSessionAction(state: SessionState): boolean {
  return state.session?.status === "active" && !state.executing;
}
