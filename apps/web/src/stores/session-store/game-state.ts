import {
  dimensionSnapshotSchema,
  dimensionSettlementSummarySchema,
  deepMerge,
} from "@covel/shared";
import type { SnapshotCharacter, SessionDispatch } from "./types.js";
import { invalidateSessionResource } from "./session-resource-reads.js";

interface GameStateSnapshotSlice {
  readonly gameState?: Record<string, unknown>;
  readonly characters: readonly SnapshotCharacter[];
  readonly characterSchema?: unknown;
  readonly dimensions?: unknown;
  readonly dimensionProviderPluginId?: string;
  readonly dimensionSettlements?: unknown;
  readonly dimensionRecovery?: unknown;
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
    dimensions: snapshot.dimensions ?? {},
    ...(snapshot.dimensionProviderPluginId
      ? { dimensionProviderPluginId: snapshot.dimensionProviderPluginId }
      : {}),
    dimensionSettlements: snapshot.dimensionSettlements ?? [],
    ...(snapshot.dimensionRecovery
      ? { dimensionRecovery: snapshot.dimensionRecovery }
      : {}),
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
  for (const key of Object.hasOwn(incoming, "dimensions")
    ? []
    : [
        "dimensions",
        "dimensionProviderPluginId",
        "dimensionSettlements",
        "dimensionRecovery",
      ]) {
    if (!Object.hasOwn(next, key) && Object.hasOwn(current, key))
      next[key] = current[key];
  }
  return next;
}

/** Host notices are monotonic hints from the pinned provider, not another authority. */
export function mergeCommittedDimensions(
  current: Record<string, unknown>,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (
    current.dimensionProviderPluginId !== payload.providerPluginId ||
    typeof payload.providerPluginId !== "string"
  )
    return current;
  const dimensions = {
    ...dimensionSnapshotSchema.parse(current.dimensions ?? {}),
  };
  if (payload.dimensions) {
    const changes = dimensionSnapshotSchema.safeParse(payload.dimensions);
    if (!changes.success) return current;
    for (const [id, entry] of Object.entries(changes.data)) {
      if (!dimensions[id] || entry.version > dimensions[id]!.version)
        dimensions[id] = entry;
    }
  }
  const summaries = Array.isArray(current.dimensionSettlements)
    ? [...current.dimensionSettlements]
    : [];
  const raw =
    payload.settlement && typeof payload.settlement === "object"
      ? (payload.settlement as Record<string, unknown>)
      : payload;
  const summary = dimensionSettlementSummarySchema.safeParse({
    source: raw.source,
    status: raw.status,
    sourceTurnId: raw.sourceTurnId,
    version: raw.version,
    ...(raw.error ? { error: raw.error } : {}),
  });
  if (summary.success) {
    const index = summaries.findIndex(
      (item) =>
        (item as { source?: { resultId?: string } })?.source?.resultId ===
        summary.data.source.resultId,
    );
    const previous =
      index < 0
        ? undefined
        : dimensionSettlementSummarySchema.parse(summaries[index]);
    if (!previous || summary.data.version > previous.version) {
      if (index < 0) summaries.push(summary.data);
      else summaries[index] = summary.data;
    }
  }
  return { ...current, dimensions, dimensionSettlements: summaries };
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
