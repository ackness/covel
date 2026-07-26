import { useEffect } from "react";
import { useSession } from "@/stores/session-store.js";

/**
 * Mirror coarse session state onto `<html>` as data attributes, so themes can
 * react to what the game is doing.
 *
 * CSS has no way to ask whether a turn is running, which capped themes at
 * static styling. With these attributes a theme can write:
 *
 *   html[data-theme="x"][data-turn="executing"] .ui-composer-frame { … }
 *
 * Deliberately coarse and framework-owned: only states the kernel itself
 * knows about. Plugin-specific state (scene, mood, combat) would need a
 * declared capability channel rather than hardcoded plugin ids.
 */
export type TurnActivity = "idle" | "executing" | "waiting" | "error";

function resolveActivity(
  executing: boolean,
  executionError: string | null,
  suspensionCount: number,
): TurnActivity {
  if (executionError) return "error";
  // A suspension outranks `executing`: the turn is technically still open but
  // the kernel is blocked on the player, which is the state worth styling.
  if (suspensionCount > 0) return "waiting";
  return executing ? "executing" : "idle";
}

export function useDocumentSessionState(): void {
  const { state } = useSession();
  const activity = resolveActivity(
    state.executing,
    state.executionError,
    state.suspensions.length,
  );
  const status = state.session?.status ?? null;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-turn", activity);
    if (status) root.setAttribute("data-session", status);
    else root.removeAttribute("data-session");

    return () => {
      root.removeAttribute("data-turn");
      root.removeAttribute("data-session");
    };
  }, [activity, status]);
}

export { resolveActivity };
