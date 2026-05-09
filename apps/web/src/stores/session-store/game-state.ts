import { deepMerge } from "@covel/shared";
import type { SnapshotCharacter } from "./types.js";

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
