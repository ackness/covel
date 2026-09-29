import { deepMerge } from "@covel/shared";
import type { SnapshotCharacter, SessionDispatch } from "./types.js";
import { invalidateSessionResource } from "./session-resource-reads.js";

interface GameStateSnapshotSlice {
  readonly gameState?: Record<string, unknown>;
  readonly characters: readonly SnapshotCharacter[];
  readonly characterSchema?: unknown;
}

/** Publish a complete current snapshot before other in-flight state reads. */
export function publishSessionGameState(
  dispatch: SessionDispatch,
  sessionId: string,
  state: Record<string, unknown>,
): void {
  invalidateSessionResource(dispatch, ["game-state", sessionId]);
  dispatch({ type: "SET_GAME_STATE", state });
}

/** Build the enriched World Model view from the current session snapshot. */
export function enrichGameStateFromSnapshot(
  snapshot: GameStateSnapshotSlice,
): Record<string, unknown> {
  const enrichedState: Record<string, unknown> = {
    ...snapshot.gameState,
    characters: snapshot.characters,
  };
  enrichedState.characterSchema = snapshot.characterSchema ?? null;
  return enrichedState;
}

export function upsertGameStateCharacter(
  gameState: Record<string, unknown>,
  character: SnapshotCharacter,
): Record<string, unknown> {
  const existing = Array.isArray(gameState.characters)
    ? (gameState.characters as SnapshotCharacter[])
    : [];
  const index = existing.findIndex((item) => item.id === character.id);
  const characters =
    index >= 0
      ? existing.with(index, { ...existing[index], ...character })
      : [...existing, character];
  return { ...gameState, characters };
}

export function mergeGameStateForReplacement(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...incoming };
  if (next.characters === undefined && current.characters !== undefined) {
    next.characters = current.characters;
  }
  if (
    next.characterSchema === undefined &&
    current.characterSchema !== undefined
  ) {
    next.characterSchema = current.characterSchema;
  }
  return next;
}

export function rebuildGameStateFromPatches(
  patches: readonly {
    readonly data?: unknown;
  }[],
): Record<string, unknown> {
  let rebuiltGameState: Record<string, unknown> = {};
  for (const patch of patches) {
    if (patch.data && typeof patch.data === "object") {
      rebuiltGameState = deepMerge(
        rebuiltGameState,
        patch.data as Record<string, unknown>,
      );
    }
  }
  return rebuiltGameState;
}
