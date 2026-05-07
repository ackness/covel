import { z } from "zod";

export interface MediaRef {
  /** Stable id; SHA-256 of content. */
  readonly id: string;
  /** MIME type, e.g. image/png, audio/wav, video/mp4. */
  readonly mime: string;
  /** Byte size; useful for budgeting and progress. */
  readonly size: number;
  /** Optional pre-signed URL. Resolve by id when absent. */
  readonly url?: string;
  /** Free-form metadata: dimensions, duration, provider ids, etc. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export const mediaRefSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  url: z.url().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type MediaRefSchema = z.infer<typeof mediaRefSchema>;

// ── MediaStore wire-shape interface ─────────────────────────────
//
// Defined in shared so browser-side code (e.g. apps/web's IDB media
// adapter) can reference the contract without pulling the Node-only
// SQLite/Postgres backends declared in `@covel/store/src/media-store.ts`.

/**
 * Lightweight ownership / metadata view returned by `MediaStore.lookup()`.
 *
 * Distinct from `MediaRef` because callers (e.g. the `/api/media/:id` route)
 * need the owner identifiers to perform per-session authorisation BEFORE
 * dereferencing the bytes. Owner fields are nullable: assets uploaded before
 * `recordOwnership()` runs (legacy, or runtime contexts that don't yet thread
 * a sessionId) will appear with `ownerSessionId: null`.
 */
export interface MediaAssetLookup {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly ownerSessionId: string | null;
  readonly ownerPluginId: string | null;
}

export interface MediaAssetRecord extends MediaAssetLookup {
  readonly createdAt: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface MediaRefRecord {
  readonly mediaId: string;
  readonly sessionId: string;
  readonly pluginId: string | null;
  readonly createdAt: string;
}

export interface MediaLifecyclePolicy {
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  readonly keepRecentBytes?: number;
  readonly dryRun?: boolean;
  readonly now?: Date;
}

export interface MediaCleanupResult {
  readonly scanned: number;
  readonly protected: number;
  readonly retained: number;
  readonly deleted: number;
  readonly totalBytes: number;
  readonly bytesDeleted: number;
  readonly bytesRetained: number;
  readonly protectedIds: readonly string[];
  readonly deletedIds: readonly string[];
}

export interface MediaStore {
  put(blob: Uint8Array | Blob, mime: string, meta?: object): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Uint8Array | Blob>;
  exists(id: string): Promise<boolean>;
  resolveUrl(ref: MediaRef): Promise<string>;
  delete(id: string, opts?: { force?: boolean }): Promise<void>;
  /**
   * Returns owner / size metadata for an existing asset, or `null` if the id
   * is unknown. Used by route-level auth checks and by the runtime to decide
   * whether an asset already belongs to the current session before re-`put`-ing.
   */
  lookup(id: string): Promise<MediaAssetLookup | null>;
  /**
   * Idempotently mark an asset as owned by `(sessionId, pluginId?)`.
   *
   * First-writer wins: a second call with a different `sessionId` does NOT
   * overwrite an already-set owner. This matches the SQLite UPDATE guard
   * (`WHERE owner_session_id IS NULL OR owner_session_id = ?`) and prevents
   * a malicious or buggy plugin from re-owning another session's asset.
   */
  recordOwnership(
    id: string,
    ownerSessionId: string,
    ownerPluginId?: string,
  ): Promise<void>;
  /**
   * Idempotently record that `sessionId` references this asset (used by fork /
   * inherit flows where multiple sessions need read access without taking
   * ownership). The unique index on `(session_id, media_id)` makes repeated
   * calls a no-op; `pluginId` is recorded as first-source metadata only and
   * does NOT participate in the key (a second addRef with a different
   * pluginId is a silent no-op, preserving the first writer's pluginId).
   */
  addRef(id: string, sessionId: string, pluginId?: string): Promise<void>;
  /**
   * Idempotently remove one session's explicit ref for an asset. This does
   * not delete bytes or ownership metadata; callers that want to reclaim the
   * asset must first verify ownership and remaining refs.
   */
  removeRef(id: string, sessionId: string): Promise<void>;
  /**
   * True if `sessionId` owns the asset OR has a row in `media_refs` for it.
   * The route handler uses this to gate dereferencing.
   */
  isReferencedBy(id: string, sessionId: string): Promise<boolean>;
  /** List stored assets for GC/quota/retention policy decisions. */
  listAssets(): Promise<readonly MediaAssetRecord[]>;
  /** List explicit cross-session refs for fork/snapshot protection. */
  listRefs(): Promise<readonly MediaRefRecord[]>;
  /**
   * Delete unprotected assets according to age/quota policy. Callers provide
   * protected ids after scanning live sessions, snapshots, and refs.
   */
  cleanup(
    protectedIds: ReadonlySet<string>,
    policy?: MediaLifecyclePolicy,
  ): Promise<MediaCleanupResult>;
  /**
   * Optional streaming read for large assets. Callers SHOULD fall back to
   * `get()` when this is undefined (e.g. tests with hand-rolled mocks).
   */
  openReadStream?(ref: MediaRef): Promise<ReadableStream<Uint8Array>>;
}
