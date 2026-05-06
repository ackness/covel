/**
 * SHA-256 helper for the browser-side media cache.
 *
 * `MediaRef.id` is the lowercase hex-encoded SHA-256 of the raw bytes
 * (see `packages/shared/src/types/media.ts`). Both `media-resolve.ts`
 * and `media-cache.ts` use this helper to verify that a Blob fetched
 * from the network — or returned from IDB — actually matches the
 * content-addressable identifier the producer plugin asserted.
 *
 * The helper is intentionally a thin wrapper around `crypto.subtle.digest`:
 *   - In the main thread, modern browsers (and Node ≥ 22 used by tests)
 *     expose `globalThis.crypto.subtle`.
 *   - In the rare environment without subtle crypto (older Workers, some
 *     test shims), `subtleAvailable()` returns `false` so callers can
 *     gracefully degrade rather than poison the cache.
 *
 * Pure function. No side effects, no logging.
 */

const HEX_LOOKUP = "0123456789abcdef";

export function subtleAvailable(): boolean {
	return (
		typeof globalThis.crypto !== "undefined" &&
		typeof globalThis.crypto.subtle?.digest === "function"
	);
}

/**
 * Compute the lowercase hex SHA-256 of an `ArrayBuffer`.
 *
 * Throws if `crypto.subtle.digest` is unavailable — callers that
 * tolerate degradation should guard with `subtleAvailable()` first.
 */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
	if (!subtleAvailable()) {
		throw new Error(
			"crypto.subtle.digest is not available in this environment",
		);
	}
	const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
	const view = new Uint8Array(digest);
	let out = "";
	for (let i = 0; i < view.length; i += 1) {
		const byte = view[i] as number;
		out += HEX_LOOKUP[byte >>> 4];
		out += HEX_LOOKUP[byte & 0x0f];
	}
	return out;
}
