import {
  materializeWorldModel,
  DIMENSION_DATA_NAMESPACE,
  dimensionRecordSchema,
  dimensionSnapshotFromRecords,
  type Proposal,
  type RuntimeResult,
  type WorldModelView,
} from "@covel/shared";
import type { DataStore } from "@covel/store";

/** Match commit eligibility, including completed guards that skipped model work. */
export function collectUpstreamWorldProposals(
  results: ReadonlyMap<string, RuntimeResult>,
  sessionId: string,
): readonly Proposal[] {
  return structuredClone(
    [...results.values()].flatMap((result) =>
      result.status === "success" || result.status === "skipped"
        ? (result.pendingProposals ?? [])
            .filter(
              (proposal) =>
                proposal.type === "character.upsert" ||
                proposal.type === "character.schema.set" ||
                proposal.type === "dimension.initialize" ||
                proposal.type === "dimension.update",
            )
            .map((proposal) => ({
              ...proposal,
              sessionId,
              turnId: result.turnId,
              source: {
                pluginId: result.pluginId,
                runtimeId: result.runtimeId,
              },
            }))
        : [],
    ),
  );
}

/** Snapshot the execution base, then provide fresh own-write overlays per read. */
export async function createWorldModelView(
  store: Pick<
    DataStore,
    | "listCharacters"
    | "getCharacterSchema"
    | "getSession"
    | "getWorld"
    | "listPluginData"
  >,
  sessionId: string,
  upstream: readonly Proposal[] = [],
  pending: readonly Proposal[] = [],
  assertLive: () => void = () => {},
  frozenDimensions?: Pick<
    WorldModelView,
    "dimensions" | "dimensionProviderPluginId"
  >,
): Promise<WorldModelView> {
  assertLive();
  const [characters, characterSchema, session] = await Promise.all([
    store.listCharacters(sessionId),
    store.getCharacterSchema(sessionId),
    store.getSession(sessionId),
  ]);
  const worldRecord = session?.worldId
    ? await store.getWorld(session.worldId)
    : null;
  assertLive();
  const providerId =
    frozenDimensions?.dimensionProviderPluginId ??
    session?.metadata?._dimensionProviderPluginId;
  if (providerId !== undefined && typeof providerId !== "string")
    throw new Error("Invalid dimension provider binding");
  const dimensionRows =
    !frozenDimensions && providerId
      ? await store.listPluginData(
          sessionId,
          providerId,
          DIMENSION_DATA_NAMESPACE,
        )
      : [];
  const dimensions =
    frozenDimensions?.dimensions ??
    dimensionSnapshotFromRecords(
      Object.fromEntries(
        dimensionRows.map((row) => [
          row.key,
          dimensionRecordSchema.parse(row.value),
        ]),
      ),
    );
  assertLive();
  const base = materializeWorldModel(
    {
      characters,
      characterSchema,
      worldRecord,
      dimensions,
      ...(providerId ? { dimensionProviderPluginId: providerId } : {}),
    },
    upstream,
    sessionId,
  );
  return overlayWorldModelView(base, sessionId, pending, assertLive);
}

export function overlayWorldModelView(
  base: WorldModelView,
  sessionId: string,
  pending: readonly Proposal[] = [],
  assertLive: () => void = () => {},
): WorldModelView {
  const snapshot = structuredClone(base);
  const current = () => {
    assertLive();
    return materializeWorldModel(snapshot, pending, sessionId);
  };
  return Object.freeze({
    get characters() {
      return current().characters;
    },
    get characterSchema() {
      return current().characterSchema;
    },
    get worldRecord() {
      assertLive();
      return structuredClone(snapshot.worldRecord);
    },
    get dimensions() {
      return current().dimensions;
    },
    get dimensionProviderPluginId() {
      assertLive();
      return snapshot.dimensionProviderPluginId;
    },
  });
}
