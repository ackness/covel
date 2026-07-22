/**
 * Unified MediaRef canonicalizer + ownership gate (docs 02 §2 / §2.1).
 *
 * Every runtime I/O boundary that can carry a MediaRef wire shape — activation
 * payload, same-execution binding value, persistent `recordAs` export, and
 * `ctx.progress.report` job data — funnels its `JsonValue` through THIS scanner
 * before schema validation / injection / persistence. Sharing one scanner is
 * the whole point: an asset the current session cannot prove it references is
 * rejected the same way whether it arrives via a binding or an export, and no
 * boundary is allowed to "补检查" only at HTTP dereference time (§2.1.4).
 *
 * Canonicalization rules (§2.1):
 *  - `id` is identity; the MediaStore lookup's `mime` / `size` are authoritative.
 *    A caller `size` that disagrees is overridden with a diagnostic; a caller
 *    `mime` that disagrees is REJECTED (mime is consumption-load-bearing — a ref
 *    pointing at the wrong content type is an integrity error, not a stale field).
 *  - the transient `url` is stripped from persistent values; the read API signs
 *    a URL on demand. `meta.caption` / `meta.alt` are position annotations and
 *    are preserved verbatim (the same asset may carry different captions).
 *  - ownership is `isReferencedBy(sessionId, id)`; a missing ref row, a missing
 *    asset, or a mime mismatch is a rejection the CALLER decides skip/fail on.
 *
 * The scanner is deliberately un-opinionated about skip vs fail: it returns the
 * canonical value plus the rejection list, and each boundary maps rejections to
 * its own vocabulary (activation fails, a required binding skips, a job report
 * throws).
 */

import { mediaRefSchema, type JsonValue, type MediaRef } from "@covel/shared";

/**
 * The narrow read surface the canonicalizer needs. Satisfied structurally by
 * both `@covel/store`'s `MediaStore` and the runtime's `MediaStoreLike`, so the
 * scanner stays decoupled from the concrete backend.
 */
export interface MediaOwnershipStore {
  lookup(
    id: string,
  ): Promise<{ readonly mime: string; readonly size: number } | null>;
  isReferencedBy(id: string, sessionId: string): Promise<boolean>;
}

export type MediaRejectionReason =
  "media-not-found" | "media-ownership-invalid" | "media-mime-mismatch";

export interface MediaRejection {
  readonly id: string;
  readonly reason: MediaRejectionReason;
  readonly message: string;
}

export interface MediaDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface MediaCanonicalization {
  /** Canonical copy of the input: url stripped, size/mime from the store. */
  readonly value: JsonValue;
  /** Every canonical MediaRef found, in document order (deduped by node). */
  readonly refs: readonly MediaRef[];
  /** Non-empty ⇒ the boundary should reject (ownership / existence / mime). */
  readonly rejections: readonly MediaRejection[];
  /** Non-fatal notes (e.g. a caller-supplied technical field was overridden). */
  readonly diagnostics: readonly MediaDiagnostic[];
}

interface CanonicalizeDeps {
  readonly store: MediaOwnershipStore;
  readonly sessionId: string;
}

/** The exact wire keys of a MediaRef; anything else means "not a MediaRef". */
const MEDIA_REF_KEYS: ReadonlySet<string> = new Set([
  "id",
  "mime",
  "size",
  "url",
  "meta",
]);

/**
 * Decide whether `node` is a MediaRef wire shape rather than a domain object
 * that merely happens to contain `id` / `mime` / `size`. `mediaRefSchema`
 * validates the required fields but zod strips extras on success, so an object
 * with foreign keys would be mis-read as a ref and have those keys silently
 * dropped by the transform. Requiring the key set to be a subset of the wire
 * keys closes that false-positive without depending on zod strict semantics.
 */
function asMediaRefWire(
  node: Record<string, unknown>,
): {
  id: string;
  mime: string;
  size: number;
  meta?: Record<string, unknown>;
} | null {
  for (const key of Object.keys(node)) {
    if (!MEDIA_REF_KEYS.has(key)) return null;
  }
  const parsed = mediaRefSchema.safeParse(node);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Recursively canonicalize every MediaRef in `value`, validating ownership
 * against `sessionId`. Lookups are memoised per id so a value that references
 * the same asset many times costs one round-trip.
 */
export async function canonicalizeMediaRefs(
  value: JsonValue,
  deps: CanonicalizeDeps,
): Promise<MediaCanonicalization> {
  const refs: MediaRef[] = [];
  const rejections: MediaRejection[] = [];
  const diagnostics: MediaDiagnostic[] = [];
  // Per-id memo: null = asset absent; undefined = not looked up yet.
  const lookupCache = new Map<
    string,
    { readonly mime: string; readonly size: number } | null
  >();
  const ownedCache = new Map<string, boolean>();

  const canonicalizeRef = async (wire: {
    id: string;
    mime: string;
    size: number;
    meta?: Record<string, unknown>;
  }): Promise<JsonValue> => {
    const stripped: MediaRef = {
      id: wire.id,
      mime: wire.mime,
      size: wire.size,
      ...(wire.meta ? { meta: wire.meta } : {}),
    };

    let entry = lookupCache.get(wire.id);
    if (entry === undefined && !lookupCache.has(wire.id)) {
      entry = await deps.store.lookup(wire.id);
      lookupCache.set(wire.id, entry);
    }
    if (!entry) {
      rejections.push({
        id: wire.id,
        reason: "media-not-found",
        message: `media asset ${wire.id} does not exist`,
      });
      return stripped as unknown as JsonValue;
    }

    let owned = ownedCache.get(wire.id);
    if (owned === undefined) {
      owned = await deps.store.isReferencedBy(wire.id, deps.sessionId);
      ownedCache.set(wire.id, owned);
    }
    if (!owned) {
      rejections.push({
        id: wire.id,
        reason: "media-ownership-invalid",
        message: `session ${deps.sessionId} has no reference to media ${wire.id}`,
      });
      return stripped as unknown as JsonValue;
    }

    if (wire.mime !== entry.mime) {
      rejections.push({
        id: wire.id,
        reason: "media-mime-mismatch",
        message: `media ${wire.id} is ${entry.mime}, ref declared ${wire.mime}`,
      });
      return stripped as unknown as JsonValue;
    }

    if (wire.size !== entry.size) {
      diagnostics.push({
        code: "media-size-overridden",
        message: `media ${wire.id} size ${wire.size} overridden with store value ${entry.size}`,
      });
    }

    // Canonical: store-authoritative mime/size, url dropped, meta preserved.
    const canonical: MediaRef = {
      id: wire.id,
      mime: entry.mime,
      size: entry.size,
      ...(wire.meta ? { meta: wire.meta } : {}),
    };
    refs.push(canonical);
    return canonical as unknown as JsonValue;
  };

  const walk = async (node: JsonValue): Promise<JsonValue> => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      const out: JsonValue[] = [];
      for (const item of node) out.push(await walk(item));
      return out;
    }
    const record = node as Record<string, JsonValue>;
    const wire = asMediaRefWire(record);
    if (wire) return canonicalizeRef(wire);
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(record)) {
      out[key] = await walk(child);
    }
    return out;
  };

  const canonicalValue = await walk(value);
  return { value: canonicalValue, refs, rejections, diagnostics };
}
