import { deepMerge } from "@covel/shared";
import type { SnapshotCharacter } from "./types.js";

interface GameStateSnapshotSlice {
  readonly gameState?: Record<string, unknown>;
  readonly characters: readonly SnapshotCharacter[];
  readonly characterSchema?: unknown;
}

/**
 * Build the enriched gameState payload from a server snapshot.
 *
 * `characters` and `characterSchema` have no incremental SSE carrier from the
 * direct-write character path (char-creator tools / player-init guard mirror
 * to plugin_data and emit only `plugin-data.changed`; `character.upserted`
 * fires solely from the `character.upsert` proposal path). A snapshot pull is
 * the only refresh point for `characterSchema` outside start/restore/reconnect.
 * Centralised here so every resync site stays consistent.
 */
export function enrichGameStateFromSnapshot(
  snapshot: GameStateSnapshotSlice,
): Record<string, unknown> {
  const enrichedState: Record<string, unknown> = {
    ...snapshot.gameState,
    characters: snapshot.characters,
  };
  if (snapshot.characterSchema) {
    enrichedState.characterSchema = snapshot.characterSchema;
  }
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
