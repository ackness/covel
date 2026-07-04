import type { MediaAssetRecord } from "@covel/shared";

/**
 * Shared listByMetadata used by ALL media backends (memory/sqlite/pg/idb):
 * one code path — backend parity by construction.
 *
 * Lives apart from `utils.ts` on purpose: this module has ZERO node built-ins,
 * so the browser-reachable idb backend can import it without dragging
 * `node:crypto` / `node:path` into the web bundle (which Vite externalizes and
 * throws on access, crashing app bootstrap). Keep it dependency-free.
 *
 * A `filter` value of `undefined` matches both a missing key and a key
 * explicitly stored as `undefined` (`meta[k] === v` reads `undefined` either
 * way). Only primitive values compare meaningfully — objects/arrays never
 * match since `===` is reference equality.
 * ponytail: full-scan over listAssets(); push down to SQL when per-session
 * media volume outgrows tens of records.
 */
export function filterAssetsByMetadata(
  assets: readonly MediaAssetRecord[],
  sessionId: string,
  filter: Readonly<Record<string, unknown>>,
): readonly MediaAssetRecord[] {
  return assets.filter((asset) => {
    if (asset.ownerSessionId !== sessionId) return false;
    const meta = asset.meta ?? {};
    return Object.entries(filter).every(([k, v]) => meta[k] === v);
  });
}
