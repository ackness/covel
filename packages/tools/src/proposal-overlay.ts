/**
 * Read-through overlays over uncommitted proposals buffered earlier in the
 * SAME execution (agent tool loop or function-runtime handler/guard).
 *
 * Domain writes now flow through proposals that commit only at the end of the
 * execution. Without an overlay a runtime that writes a value and then reads it
 * back in the same execution sees the PRE-write state, so it either writes
 * twice or "corrects" a value that was already correct. These helpers let an
 * execution read its own buffered writes. Last write wins, matching the order
 * the commit pipeline applies them in.
 *
 * Scope: buffered proposals are per-execution — a single runtime's tool loop
 * or one function-runtime handler/guard. Cross-runtime same-turn reads are not
 * merged here (different runtimes carry different buffers).
 */

import type { CharacterUpsertPayload, Proposal } from "@covel/shared";

// Encode the tuple so arbitrary namespace/key strings cannot collide.
const pluginDataKey = (namespace: string, key: string): string =>
  JSON.stringify([namespace, key]);

/**
 * Latest buffered plugin-data value for `(pluginId, namespace, key)`.
 * `hit: false` means no buffered write touched this key — the caller falls back
 * to the store. Only the given plugin's own writes are considered; the store
 * read is already plugin-scoped and the overlay must not widen that.
 */
export function overlayPluginDataValue(
  proposals: readonly Proposal[],
  pluginId: string,
  namespace: string,
  key: string,
): { readonly hit: boolean; readonly value?: unknown } {
  let result: { hit: boolean; value?: unknown } = { hit: false };
  for (const proposal of proposals) {
    if (proposal.source.pluginId !== pluginId) continue;
    if (proposal.type === "plugin.data") {
      const p = proposal.payload;
      if (p.namespace === namespace && p.key === key) {
        result = { hit: true, value: p.value };
      }
    } else if (proposal.type === "plugin.data.batch") {
      for (const item of proposal.payload.items ?? []) {
        if (item.namespace === namespace && item.key === key) {
          result = { hit: true, value: item.value };
        }
      }
    } else if (proposal.type === "plugin.data.delete") {
      const p = proposal.payload;
      if (p.namespace === namespace && p.key === key) {
        result = { hit: true, value: null };
      }
    }
  }
  return result;
}

/**
 * All buffered plugin-data rows for `(pluginId[, namespace])`, keyed
 * by JSON-encoded `[namespace, key]` so callers can merge them over store rows
 * (last write wins).
 */
export function overlayPluginDataRows(
  proposals: readonly Proposal[],
  pluginId: string,
  namespace?: string,
): Map<
  string,
  { namespace: string; key: string; value: unknown; deleted?: true }
> {
  const overlay = new Map<
    string,
    { namespace: string; key: string; value: unknown; deleted?: true }
  >();
  const add = (ns: string, key: string, value: unknown): void => {
    if (namespace !== undefined && ns !== namespace) return;
    overlay.set(pluginDataKey(ns, key), { namespace: ns, key, value });
  };
  const remove = (ns: string, key: string): void => {
    if (namespace !== undefined && ns !== namespace) return;
    overlay.set(pluginDataKey(ns, key), {
      namespace: ns,
      key,
      value: null,
      deleted: true,
    });
  };
  for (const proposal of proposals) {
    if (proposal.source.pluginId !== pluginId) continue;
    if (proposal.type === "plugin.data") {
      const p = proposal.payload;
      add(p.namespace, p.key, p.value);
    } else if (proposal.type === "plugin.data.batch") {
      for (const item of proposal.payload.items ?? []) {
        add(item.namespace, item.key, item.value);
      }
    } else if (proposal.type === "plugin.data.delete") {
      remove(proposal.payload.namespace, proposal.payload.key);
    }
  }
  return overlay;
}

/**
 * Latest buffered `character.upsert` payload per character id (last write
 * wins). Characters are session-scoped shared kernel data, so no plugin filter
 * is applied — a buffer only ever holds one execution's own writes anyway.
 */
export function overlayCharacters(
  proposals: readonly Proposal[],
): Map<string, CharacterUpsertPayload> {
  const overlay = new Map<string, CharacterUpsertPayload>();
  for (const proposal of proposals) {
    if (proposal.type === "character.upsert") {
      overlay.set(proposal.payload.id, proposal.payload);
    }
  }
  return overlay;
}
