/**
 * Media-store contract stub.
 *
 * FIXME(P0-a-merge): replace this stub with `@covel/shared` / `@covel/store`
 * imports once `agent/codex-p0a-media-store` is merged. The shapes below are
 * taken verbatim from SPEC §5.1 (a)(b)(g) and must stay byte-compatible — if
 * Codex A renames a method when wiring the real implementation the
 * coordinator will reconcile both worktrees at merge time.
 *
 * This file lives under `_stubs/` so it can be deleted in one go without
 * dragging route or middleware code with it.
 */

/**
 * Reference to a media asset stored in the framework `MediaStore`.
 *
 * `id` is the SHA-256 of the bytes (content-addressable). `url` is an
 * optional pre-signed access URL produced by `MediaStore.resolveUrl()`;
 * never trust it across sessions because the id is the source of truth.
 *
 * Mirrors the type planned for `packages/shared/src/types/media.ts`.
 */
export interface MediaRef {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly url?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Ownership metadata returned by `MediaStore.lookup()`. Used by the
 * `/api/media/:id` route to decide whether the caller's session is
 * allowed to dereference the asset.
 */
export interface MediaAssetLookup {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly ownerSessionId: string;
  readonly ownerPluginId?: string;
}

/**
 * Server-facing surface of the upcoming `MediaStore` (Codex A scope).
 *
 * The four "core" methods (`put` / `get` / `exists` / `resolveUrl` /
 * `delete`) are taken verbatim from SPEC §5.1 (b). The three extra hooks
 * (`lookup`, `isReferencedBy`, `openReadStream`) are auth/streaming
 * helpers needed by the route in this worktree; if Codex A picks
 * different names when wiring the real implementation the coordinator
 * will reconcile both at merge time.
 */
export interface MediaStore {
  put(blob: Uint8Array | Blob, mime: string, meta?: object): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Uint8Array | Blob>;
  exists(id: string): Promise<boolean>;
  resolveUrl(ref: MediaRef): Promise<string>;
  delete(id: string, opts?: { force?: boolean }): Promise<void>;
  /** Returns ownership metadata or null if id unknown. */
  lookup(id: string): Promise<MediaAssetLookup | null>;
  /** True if `sessionId` references this media (owner OR rows in media_refs). */
  isReferencedBy(id: string, sessionId: string): Promise<boolean>;
  /**
   * Stream the bytes for low-memory delivery. Optional — fall back to
   * `get()` when not implemented (smaller assets only).
   */
  openReadStream?(ref: MediaRef): Promise<ReadableStream<Uint8Array>>;
}
