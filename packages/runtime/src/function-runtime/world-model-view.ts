import {
  materializeWorldModel,
  type Proposal,
  type RuntimeResult,
  type WorldModelView,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import { getPendingProposals } from "@covel/tools";

/** Match commit eligibility, including completed guards that skipped model work. */
export function collectUpstreamWorldProposals(
  results: ReadonlyMap<string, RuntimeResult>,
  sessionId: string,
): readonly Proposal[] {
  return structuredClone(
    [...results.values()].flatMap((result) =>
      result.status === "success" || result.status === "skipped"
        ? getPendingProposals(result.output)
            .filter(
              (proposal) =>
                proposal.type === "character.upsert" ||
                proposal.type === "character.schema.set",
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
  store: DataStore,
  sessionId: string,
  upstream: readonly Proposal[] = [],
  pending: readonly Proposal[] = [],
  assertLive: () => void = () => {},
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
  const base = materializeWorldModel(
    { characters, characterSchema, worldRecord },
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
  });
}
