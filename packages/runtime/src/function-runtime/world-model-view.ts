import {
  materializeWorldModel,
  DIMENSION_DATA_NAMESPACE,
  dimensionRecordSchema,
  dimensionSnapshotFromRecords,
  localizedWorldText,
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

export type WorldModelReadStore = Pick<
  DataStore,
  | "listCharacters"
  | "getCharacterSchema"
  | "getSession"
  | "getWorld"
  | "listPluginData"
>;

/**
 * Committed world-model state cannot change inside one execution (writes stay
 * buffered until finalize), so every runtime of that execution can share one
 * read of it. Each caller still receives its own copy.
 */
export function memoizeWorldModelReads(
  store: WorldModelReadStore,
): WorldModelReadStore {
  const cache = new Map<string, Promise<unknown>>();
  const memo = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    let hit = cache.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      cache.set(key, hit);
      hit.catch(() => cache.delete(key));
    }
    return hit.then((value) => structuredClone(value));
  };
  return {
    listCharacters: (sessionId) =>
      memo(`characters\u0000${sessionId}`, () =>
        store.listCharacters(sessionId),
      ),
    getCharacterSchema: (sessionId) =>
      memo(`schema\u0000${sessionId}`, () =>
        store.getCharacterSchema(sessionId),
      ),
    getSession: (sessionId) =>
      memo(`session\u0000${sessionId}`, () => store.getSession(sessionId)),
    getWorld: (worldId) =>
      memo(`world\u0000${worldId}`, () => store.getWorld(worldId)),
    listPluginData: (sessionId, pluginId, namespace, pagination) =>
      pagination
        ? store.listPluginData(sessionId, pluginId, namespace, pagination)
        : memo(
            `plugin-data\u0000${sessionId}\u0000${pluginId}\u0000${namespace ?? ""}`,
            () => store.listPluginData(sessionId, pluginId, namespace),
          ),
  };
}

/**
 * The world record as one session reads it: `name` and `description` in the
 * session's content locale when the world ships that translation. Plugins then
 * get the session's language from `ctx.world` and from their store facade
 * without resolving anything themselves.
 */
export function worldForSession<
  T extends {
    readonly name?: string;
    readonly description?: string;
    readonly metadata?: Readonly<Record<string, unknown>> | null;
  },
>(world: T | null | undefined, locale: string | undefined): T | null {
  if (!world) return null;
  const { name, description } = localizedWorldText(world, locale);
  return {
    ...world,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
}

/** Snapshot the execution base, then provide fresh own-write overlays per read. */
export async function createWorldModelView(
  store: WorldModelReadStore,
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
  const storedWorld = session?.worldId
    ? await store.getWorld(session.worldId)
    : null;
  const worldRecord = worldForSession(storedWorld, session?.locale);
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
    session?.locale,
  );
  return overlayWorldModelView(
    base,
    sessionId,
    pending,
    assertLive,
    session?.locale,
  );
}

export function overlayWorldModelView(
  base: WorldModelView,
  sessionId: string,
  pending: readonly Proposal[] = [],
  assertLive: () => void = () => {},
  /** The session's content locale. */
  locale?: string,
): WorldModelView {
  const snapshot = structuredClone(base);
  // No proposal writes the world record, and it holds the whole setting text:
  // keep it out of the copy that every read of the other properties makes.
  const { worldRecord: _worldRecord, ...model } = snapshot;
  // `pending` is the caller's live write buffer. The model with the first
  // `applied.length` of its proposals is kept, so a read validates only what
  // was buffered since the last one. A buffer that is no longer those
  // proposals followed by new ones is read from the start.
  let applied: readonly Proposal[] = [];
  let state: WorldModelView | undefined;
  const current = () => {
    assertLive();
    const grown =
      state !== undefined &&
      pending.length >= applied.length &&
      applied.every((proposal, index) => pending[index] === proposal);
    const next = [...pending];
    state = grown
      ? next.length === applied.length
        ? state!
        : materializeWorldModel(
            state!,
            next.slice(applied.length),
            sessionId,
            locale,
          )
      : materializeWorldModel(model, next, sessionId, locale);
    applied = next;
    return state;
  };
  return Object.freeze({
    get characters() {
      return structuredClone(current().characters);
    },
    get characterSchema() {
      return structuredClone(current().characterSchema);
    },
    get worldRecord() {
      assertLive();
      return structuredClone(snapshot.worldRecord);
    },
    get dimensions() {
      return structuredClone(current().dimensions);
    },
    get dimensionProviderPluginId() {
      assertLive();
      return snapshot.dimensionProviderPluginId;
    },
  });
}
