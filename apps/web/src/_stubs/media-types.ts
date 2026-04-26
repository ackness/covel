// FIXME(P0-a-merge): replace this stub with `@covel/shared` import
// once `agent/codex-p0a-media-store` is merged. The shape below is taken
// verbatim from SPEC §5.1 (a) and must stay byte-compatible.
//
// Once the real type lands at `@covel/shared/types/media`, every file
// that imports from this stub should be updated to import from there
// and this file deleted. Do not drift the shape — keep it identical.

export interface MediaRef {
  /** Stable id; SHA-256 of content (content-addressable). */
  readonly id: string;
  /** MIME type, e.g. 'image/png', 'audio/wav', 'video/mp4'. */
  readonly mime: string;
  /** Byte size; useful for budgeting / progress. */
  readonly size: number;
  /**
   * Optional pre-signed URL. If absent, resolve via the media-token endpoint.
   * Never trust this URL across sessions — content-addressable means the id
   * is the source of truth.
   */
  readonly url?: string;
  /** Free-form metadata: dimensions for images, duration for audio, etc. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Structural type guard: identifies any value that has the minimum
 * MediaRef shape (`{ id: string, mime: string, size: number }`).
 *
 * Loose on purpose — plugin specs may carry extra fields. The downstream
 * resolver only needs id/mime/size to function.
 */
export function isMediaRef(value: unknown): value is MediaRef {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.mime === "string" &&
    v.mime.length > 0 &&
    typeof v.size === "number" &&
    Number.isFinite(v.size)
  );
}
