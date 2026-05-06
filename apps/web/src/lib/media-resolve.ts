/**
 * Resolve a `MediaRef` into a usable URL string for `<img|audio|video src>`.
 *
 * Resolution order (per SPEC §5.1 (g)):
 *   1. /api/sessions/:sessionId/media-token?id=:id authorizes the session
 *   2. (Tauri only) native file-system fast path — only consulted *after*
 *      the server has authorized the current session for this ref. This
 *      prevents a session B from reading session A's bytes purely because
 *      it learned A's content-addressable id.
 *   3. IDB cache hit                    → URL.createObjectURL(blob), fromCache=true
 *   4. signed URL fetch                 → cache + return blob URL
 *   5. any failure                      → explicit error result + sentinel URL
 *
 * The token endpoint provides the framework path for refs that arrive
 * without an eager `url` from the producer plugin.
 *
 * The returned `url` is a blob URL when `fromCache` is false; the caller
 * is responsible for `URL.revokeObjectURL` on unmount. When `fromCache` is
 * true, the URL is also a blob URL, but we keep the underlying record in
 * IDB — so revoking is still required, but the next render will rebuild
 * the URL trivially from cache.
 *
 * TODO(audit-2026-04-26 P0 follow-up): the Tauri fast path currently
 * trusts the session authorization gate above. A defence-in-depth
 * follow-up is to plumb `sessionId` into `native_media_read` and have
 * the Rust side verify ownership directly against the sidecar's
 * `media_assets` / `media_refs` rows before serving bytes. That keeps
 * the fast path safe even if a future caller forgets to authorize first.
 */

import type { MediaRef } from "@covel/shared";
import {
	getCachedMedia,
	putCachedMedia,
	type MediaCacheRecord,
} from "./media-cache.js";
import { sha256Hex, subtleAvailable } from "./media-hash.js";
import { readNativeTauriMedia } from "./tauri-media.js";

export interface ResolveOptions {
	readonly sessionId: string;
	readonly signal?: AbortSignal;
}

export interface ResolveResult {
	readonly url: string;
	readonly blob?: Blob;
	/** True when the URL came from IDB. */
	readonly fromCache: boolean;
	readonly ok: boolean;
}

// 1x1 transparent PNG, base64-encoded. Stable sentinel for failures so
// the UI never shows a broken-image glyph.
const TRANSPARENT_PNG_DATA_URI =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Path of the short-lived media-token endpoint.
 *
 * Server-issued signed URL endpoint for session-authorized media access.
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

/**
 * Loose MIME equality used by the cache integrity check.
 *
 * We deliberately compare only the base media-type (everything before the
 * first `;`) and ignore parameters such as `charset` or `boundary`. This
 * keeps the check robust against trivial header variations like
 * `image/png` vs `image/png; charset=binary` while still rejecting
 * obviously different payloads (`text/html` for an `image/png` ref).
 */
function mimeMatches(blobMime: string, expectedMime: string): boolean {
	const normalize = (m: string): string =>
		m.split(";", 1)[0]!.trim().toLowerCase();
	return normalize(blobMime) === normalize(expectedMime);
}

/**
 * Verify that a freshly fetched (or cached) blob actually matches the
 * `MediaRef` shape. Returns `null` on success, otherwise a short reason
 * string suitable for `console.warn`.
 *
 * Order matters: cheap structural checks (size, MIME) come first, the
 * expensive SHA-256 last and is skipped (with a warning) when the runtime
 * lacks `crypto.subtle`.
 */
async function verifyBlobAgainstRef(
	blob: Blob,
	ref: MediaRef,
): Promise<string | null> {
	if (blob.size !== ref.size) {
		return `size mismatch (got ${blob.size}, expected ${ref.size})`;
	}
	if (ref.mime && blob.type && !mimeMatches(blob.type, ref.mime)) {
		return `mime mismatch (got ${blob.type}, expected ${ref.mime})`;
	}
	if (!subtleAvailable()) {
		// Degrade gracefully: structural checks already passed, so accept the
		// blob but surface the missing capability so operators can investigate.
		console.warn(
			"[media-resolve] crypto.subtle unavailable — skipping SHA-256 check for",
			ref.id,
		);
		return null;
	}
	try {
		const buffer = await blob.arrayBuffer();
		const hash = await sha256Hex(buffer);
		if (hash !== ref.id) {
			return `sha256 mismatch (got ${hash}, expected ${ref.id})`;
		}
	} catch (err: unknown) {
		// A digest failure is treated as "do not trust" — same as a hash mismatch.
		return `sha256 digest threw: ${(err as { message?: string })?.message ?? "unknown"}`;
	}
	return null;
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
		const failure = await verifyBlobAgainstRef(blob, ref);
		if (failure) {
			console.warn(
				"[media-resolve] dropping fetched blob — integrity check failed:",
				failure,
				ref.id,
			);
			return null;
		}
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
 * Pull a blob from IDB and validate its integrity against `ref`. A
 * mismatched record is evicted so the next call re-fetches. Returns
 * `null` when no usable blob is present.
 */
async function getAndVerifyCachedMedia(ref: MediaRef): Promise<Blob | null> {
	const cached = await getCachedMedia(ref.id, ref);
	return cached?.blob ?? null;
}

/**
 * Resolve a `MediaRef` to a renderable URL.
 *
 * Never throws. On failure returns `ok: false` with the sentinel URL so
 * non-React callers can still keep a stable fallback value.
 */
export async function resolveMediaSrc(
	ref: MediaRef,
	opts: ResolveOptions,
): Promise<ResolveResult> {
	// 1. Authorize the session before consulting any local fast path or the
	// shared browser cache. This is the single chokepoint that prevents a
	// session B from reading session A's bytes by stealing the SHA-addressed
	// id (the on-disk SHA-bin file isn't itself session-scoped).
	const signedUrl = await fetchSignedUrl(ref, opts);
	if (!signedUrl) {
		return { url: TRANSPARENT_PNG_DATA_URI, fromCache: false, ok: false };
	}

	// 2. Desktop Tauri can read the local MediaStore layout directly from
	// native fs — only after step 1 confirmed the session is authorised.
	// See the file-level TODO for the planned defence-in-depth Rust check.
	const nativeBlob = await readNativeTauriMedia(ref, { authorized: true });
	if (nativeBlob) {
		return {
			url: URL.createObjectURL(nativeBlob),
			blob: nativeBlob,
			fromCache: true,
			ok: true,
		};
	}

	// 3. IDB cache hit (validated against ref to prevent serving a
	// poisoned record from a previous miscached fetch).
	const cachedBlob = await getAndVerifyCachedMedia(ref);
	if (cachedBlob) {
		return {
			url: URL.createObjectURL(cachedBlob),
			blob: cachedBlob,
			fromCache: true,
			ok: true,
		};
	}

	// 4. Fetch via the server-issued signed URL.
	const fetched = await fetchBlobAndCache(ref, signedUrl, opts);
	if (fetched) {
		return {
			url: URL.createObjectURL(fetched.blob),
			blob: fetched.blob,
			fromCache: false,
			ok: true,
		};
	}

	return { url: TRANSPARENT_PNG_DATA_URI, fromCache: false, ok: false };
}

export const __testing = {
	TRANSPARENT_PNG_DATA_URI,
	verifyBlobAgainstRef,
	mimeMatches,
};
