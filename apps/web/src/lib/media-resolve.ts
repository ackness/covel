/**
 * Resolve a `MediaRef` into a usable URL string for `<img|audio|video src>`.
 *
 * Resolution order (per SPEC §5.1 (g)):
 *   1. IDB cache hit                    → URL.createObjectURL(blob), fromCache=true
 *   2. ref.url already signed           → fetch + cache + return blob URL
 *   3. /api/sessions/:sessionId/media-token?id=:id  → fetch token endpoint,
 *      use returned signed URL, cache, return blob URL
 *   4. any failure                      → 1x1 transparent PNG sentinel data URI
 *
 * The token endpoint is provided by a follow-up backend PR — see
 * `MEDIA_TOKEN_ENDPOINT` below. Until then, the most common path is (2):
 * the image plugins eagerly attach `ref.url` after generation.
 *
 * The returned `url` is a blob URL when `fromCache` is false; the caller
 * is responsible for `URL.revokeObjectURL` on unmount. When `fromCache` is
 * true, the URL is also a blob URL, but we keep the underlying record in
 * IDB — so revoking is still required, but the next render will rebuild
 * the URL trivially from cache.
 */

import type { MediaRef } from "@covel/shared";
import {
  getCachedMedia,
  putCachedMedia,
  type MediaCacheRecord,
} from "./media-cache.js";

export interface ResolveOptions {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

export interface ResolveResult {
  readonly url: string;
  readonly blob?: Blob;
  /** True when the URL came from IDB; caller can skip eager revoke. */
  readonly fromCache: boolean;
}

// 1x1 transparent PNG, base64-encoded. Stable sentinel for failures so
// the UI never shows a broken-image glyph.
const TRANSPARENT_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Path of the short-lived media-token endpoint.
 *
 * TODO(P0-a-followup): backend endpoint added in a follow-up PR. Until then
 * the resolver falls back to `ref.url` when present, or the sentinel data
 * URI when both cache and `ref.url` are missing.
 */
export function MEDIA_TOKEN_ENDPOINT(sessionId: string, id: string): string {
  return (
    "/api/sessions/" +
    encodeURIComponent(sessionId) +
    "/media-token?id=" +
    encodeURIComponent(id)
  );
}

interface TokenResponse {
  readonly url: string;
}

async function fetchSignedUrl(
  ref: MediaRef,
  opts: ResolveOptions,
): Promise<string | null> {
  try {
    const res = await fetch(MEDIA_TOKEN_ENDPOINT(opts.sessionId, ref.id), {
      method: "GET",
      signal: opts.signal,
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!res.ok) {
      console.warn(
        "[media-resolve] media-token endpoint returned",
        res.status,
        ref.id,
      );
      return null;
    }
    const json = (await res.json()) as Partial<TokenResponse>;
    if (typeof json?.url !== "string" || json.url.length === 0) {
      console.warn("[media-resolve] media-token endpoint missing url", ref.id);
      return null;
    }
    return json.url;
  } catch (err: unknown) {
    // AbortError from a stale render is fine — don't spam the console.
    if ((err as { name?: string })?.name !== "AbortError") {
      console.warn("[media-resolve] media-token fetch failed", err);
    }
    return null;
  }
}

async function fetchBlobAndCache(
  ref: MediaRef,
  url: string,
  opts: ResolveOptions,
): Promise<{ readonly blob: Blob } | null> {
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: opts.signal,
      credentials: "same-origin",
    });
    if (!res.ok) {
      console.warn(
        "[media-resolve] blob fetch returned",
        res.status,
        ref.id,
        url,
      );
      return null;
    }
    const blob = await res.blob();
    const record: MediaCacheRecord = {
      id: ref.id,
      mime: ref.mime,
      size: ref.size,
      blob,
      savedAt: Date.now(),
    };
    // Best-effort cache; never block on failure.
    await putCachedMedia(record);
    return { blob };
  } catch (err: unknown) {
    if ((err as { name?: string })?.name !== "AbortError") {
      console.warn("[media-resolve] blob fetch failed", err);
    }
    return null;
  }
}

/**
 * Resolve a `MediaRef` to a renderable URL.
 *
 * Never throws. On failure returns the sentinel transparent-PNG data URI
 * so callers can render without conditional logic.
 */
export async function resolveMediaSrc(
  ref: MediaRef,
  opts: ResolveOptions,
): Promise<ResolveResult> {
  // 1. IDB cache hit
  const cached = await getCachedMedia(ref.id);
  if (cached?.blob) {
    return {
      url: URL.createObjectURL(cached.blob),
      blob: cached.blob,
      fromCache: true,
    };
  }

  // 2. ref.url is already a usable signed URL — fetch + cache + return blob URL
  if (typeof ref.url === "string" && ref.url.length > 0) {
    const fetched = await fetchBlobAndCache(ref, ref.url, opts);
    if (fetched) {
      return {
        url: URL.createObjectURL(fetched.blob),
        blob: fetched.blob,
        fromCache: false,
      };
    }
    // Fall through to token endpoint.
  }

  // 3. token endpoint (server-issued signed URL)
  const signedUrl = await fetchSignedUrl(ref, opts);
  if (signedUrl) {
    const fetched = await fetchBlobAndCache(ref, signedUrl, opts);
    if (fetched) {
      return {
        url: URL.createObjectURL(fetched.blob),
        blob: fetched.blob,
        fromCache: false,
      };
    }
  }

  // 4. Sentinel placeholder — never throw, callers can render unconditionally.
  return { url: TRANSPARENT_PNG_DATA_URI, fromCache: false };
}

export const __testing = {
  TRANSPARENT_PNG_DATA_URI,
};
