import type { PluginProposal as Proposal } from "./plugin-api.js";
import { applyDataOps, type DataOp, type DataOpsCurrent } from "./data-ops.js";
import type { JsonValue } from "./types.js";

// Encode the tuple so arbitrary namespace/key strings cannot collide.
const pluginDataKey = (namespace: string, key: string): string =>
  JSON.stringify([namespace, key]);

const ABSENT: DataOpsCurrent = { exists: false };

/** One buffered write to one key, whatever proposal carried it. */
type KeyWrite = { readonly namespace: string; readonly key: string } & (
  | { readonly kind: "set"; readonly value: unknown }
  | { readonly kind: "delete" }
  | { readonly kind: "update"; readonly ops: readonly DataOp[] }
);

/** The plugin-data writes of one proposal, in order. */
function keyWrites(proposal: Proposal): readonly KeyWrite[] {
  switch (proposal.type) {
    case "plugin.data":
      return [{ ...proposal.payload, kind: "set" }];
    case "plugin.data.batch":
      return (proposal.payload.items ?? []).map((item) => ({
        ...item,
        kind: "set" as const,
      }));
    case "plugin.data.delete":
      return [{ ...proposal.payload, kind: "delete" }];
    case "plugin.data.update":
      return [{ ...proposal.payload, kind: "update" }];
    default:
      return [];
  }
}

/**
 * The state of a key after one write, or `undefined` when the write leaves it
 * unchanged: a `plugin.data.update` whose operations fail against `state` is
 * skipped, the same write the commit rejects.
 */
function applyWrite(
  write: KeyWrite,
  state: DataOpsCurrent,
): DataOpsCurrent | undefined {
  if (write.kind === "set")
    return { exists: true, value: write.value as JsonValue };
  if (write.kind === "delete") return ABSENT;
  const result = applyDataOps(state, write.ops);
  if (!result.ok) return undefined;
  return result.exists ? { exists: true, value: result.value } : ABSENT;
}

/**
 * Projects the plugin's buffered writes onto one key. `base` is the stored
 * value of `(pluginId, namespace, key)`, which the caller reads first.
 * Whole-value writes replace the state, deletes remove it, and
 * `plugin.data.update` applies its operations to the state with the same
 * `applyDataOps` the commit uses. An update whose operations fail is skipped,
 * as the commit rejects it, and the state stays as it was. `hit` is true when
 * any buffered write targets the key, including a skipped update. Only the given plugin's own writes are considered; the store
 * read is already plugin-scoped and the overlay must not widen that. Returned
 * values are not copies.
 */
export function overlayPluginDataValue(
  proposals: readonly Proposal[],
  pluginId: string,
  namespace: string,
  key: string,
  base: DataOpsCurrent,
): { readonly hit: boolean } & DataOpsCurrent {
  let state = base;
  let hit = false;
  for (const proposal of proposals) {
    if (proposal.source.pluginId !== pluginId) continue;
    for (const write of keyWrites(proposal)) {
      if (write.namespace !== namespace || write.key !== key) continue;
      hit = true;
      state = applyWrite(write, state) ?? state;
    }
  }
  return state.exists
    ? { hit, exists: true, value: state.value }
    : { hit, exists: false };
}

/** One projected row of {@link overlayPluginDataRows}. */
export interface PluginDataOverlayRow {
  namespace: string;
  key: string;
  value: unknown;
  deleted?: true;
}

/**
 * All buffered plugin-data rows for `(pluginId[, namespace])`, keyed by
 * JSON-encoded `[namespace, key]` so callers can merge them over store rows
 * (last write wins). A deleted key keeps an entry with `deleted: true`.
 * `baseRows` are the stored rows: a `plugin.data.update` starts from the
 * latest buffered value of its key, else the matching base row, else absent,
 * and is skipped when its operations fail. Returned values are not copies.
 */
export function overlayPluginDataRows(
  proposals: readonly Proposal[],
  pluginId: string,
  namespace?: string,
  baseRows?: Iterable<{
    readonly namespace: string;
    readonly key: string;
    readonly value: unknown;
  }>,
): Map<string, PluginDataOverlayRow> {
  const overlay = new Map<string, PluginDataOverlayRow>();
  let base: Map<string, unknown> | undefined;
  const baseOf = (id: string): DataOpsCurrent => {
    if (!base) {
      base = new Map();
      for (const row of baseRows ?? [])
        base.set(pluginDataKey(row.namespace, row.key), row.value);
    }
    return base.has(id)
      ? { exists: true, value: base.get(id) as JsonValue }
      : ABSENT;
  };
  for (const proposal of proposals) {
    if (proposal.source.pluginId !== pluginId) continue;
    for (const write of keyWrites(proposal)) {
      if (namespace !== undefined && write.namespace !== namespace) continue;
      const id = pluginDataKey(write.namespace, write.key);
      const previous = overlay.get(id);
      const state: DataOpsCurrent = !previous
        ? baseOf(id)
        : previous.deleted
          ? ABSENT
          : { exists: true, value: previous.value as JsonValue };
      const next = applyWrite(write, state);
      if (next === undefined) continue;
      overlay.set(
        id,
        next.exists
          ? { namespace: write.namespace, key: write.key, value: next.value }
          : {
              namespace: write.namespace,
              key: write.key,
              value: null,
              deleted: true,
            },
      );
    }
  }
  return overlay;
}
