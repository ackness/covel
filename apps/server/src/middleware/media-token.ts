/**
 * Media-token middleware — short-lived HMAC-SHA256 signatures for /api/media/:id.
 *
 * SPEC §5.1 (g): `MediaRef.id` is content-addressable, which means anyone
 * who learns the id can fetch the bytes if the route does not enforce a
 * session-scoped capability check. We solve this with a stateless signed
 * token: the server signs `{ id, sessionId, exp }` with a process-level
 * HMAC secret; the route verifies the signature, that the token has not
 * expired, and that the `id` in the token matches the URL parameter
 * before consulting `MediaStore.isReferencedBy()`.
 *
 * Token format (compact, URL-safe):
 *
 *   base64url(JSON({id, sessionId, exp})) + "." + base64url(hmac)
 *
 * `exp` is millis since epoch. Default TTL is 5 minutes; callers can
 * override when they know they need longer (rare). Signatures use
 * `crypto.timingSafeEqual` for constant-time comparison.
 *
 * Secret resolution:
 *   1. `COVEL_MEDIA_TOKEN_SECRET` — required in production. Server
 *      fail-fasts at first call if absent and `NODE_ENV=production`.
 *   2. Otherwise (dev/test) we generate a 32-byte random secret on
 *      first call and log a single warning explaining that the secret
 *      is per-process (tokens become invalid on restart) and that
 *      production must configure the env var explicitly.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readEnvString, readRuntimeEnv } from "@covel/shared";

/** Default short-lived TTL for media access tokens (5 minutes). */
export const MEDIA_TOKEN_TTL_MS = 5 * 60 * 1000;

export interface SignMediaTokenInput {
	readonly id: string;
	readonly sessionId: string;
	/** Millis since epoch when this token expires. */
	readonly exp: number;
}

interface MediaTokenPayload {
	readonly id: string;
	readonly sessionId: string;
	readonly exp: number;
}

export type VerifyMediaTokenResult =
	| {
			readonly ok: true;
			readonly id: string;
			readonly sessionId: string;
			readonly exp: number;
	  }
	| {
			readonly ok: false;
			readonly reason:
				| "malformed"
				| "expired"
				| "bad_signature"
				| "id_mismatch";
	  };

// ── Secret resolution ────────────────────────────────────────────

/**
 * Process-level cache for the dev-mode random secret. Lives only in
 * memory; restarting the dev server invalidates outstanding tokens
 * (acceptable trade-off for the dev tier).
 */
let cachedDevSecret: string | undefined;
let warnedAboutDevSecret = false;

/**
 * Read the active media-token secret from the environment. Falls back to
 * a per-process random secret in non-production. Throws in production
 * when the secret is absent so the operator notices immediately.
 */
export function getMediaTokenSecret(): string {
	const fromEnv = readEnvString("COVEL_MEDIA_TOKEN_SECRET");
	if (fromEnv && fromEnv.trim().length > 0) {
		return fromEnv;
	}

	const isProd = readRuntimeEnv().nodeEnv === "production";
	if (isProd) {
		throw new Error(
			"COVEL_MEDIA_TOKEN_SECRET must be configured in production — refusing to issue media access tokens with an ephemeral secret.",
		);
	}

	if (!cachedDevSecret) {
		cachedDevSecret = randomBytes(32).toString("base64url");
	}
	if (!warnedAboutDevSecret) {
		warnedAboutDevSecret = true;
		// eslint-disable-next-line no-console
		console.warn(
			"[media-token] COVEL_MEDIA_TOKEN_SECRET not set — generated a per-process random secret. " +
				"All issued tokens become invalid when this process restarts. Production MUST set COVEL_MEDIA_TOKEN_SECRET explicitly.",
		);
	}
	return cachedDevSecret;
}

/**
 * For tests only: forget any cached dev-mode secret + warning state so
 * subsequent calls re-derive from the environment. NOT exported via
 * `index.ts`; tests reach into the module path directly.
 */
export function _resetMediaTokenSecretForTests(): void {
	cachedDevSecret = undefined;
	warnedAboutDevSecret = false;
}

// ── Encoding helpers ─────────────────────────────────────────────

function toBase64Url(buf: Buffer): string {
	return buf.toString("base64url");
}

function fromBase64Url(input: string): Buffer | null {
	// Reject non-base64url chars early so malformed tokens don't decode to
	// accidental garbage that just happens to verify.
	if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
	try {
		return Buffer.from(input, "base64url");
	} catch {
		return null;
	}
}

function hmacSign(secret: string, body: string): Buffer {
	return createHmac("sha256", secret).update(body).digest();
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Sign a `{ id, sessionId, exp }` triple into a compact token string.
 *
 * The caller is responsible for choosing `exp`. Helpers:
 * `signMediaTokenForSession()` below issues a default 5-minute TTL.
 */
export function signMediaToken(
	input: SignMediaTokenInput,
	secret: string,
): string {
	if (!secret) {
		throw new Error("signMediaToken: secret is required");
	}
	const payload: MediaTokenPayload = {
		id: input.id,
		sessionId: input.sessionId,
		exp: input.exp,
	};
	const body = toBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
	const sig = toBase64Url(hmacSign(secret, body));
	return `${body}.${sig}`;
}

/**
 * Convenience helper: issue a 5-minute (or caller-supplied) signed
 * token for `(id, sessionId)`. Reads the secret from env via
 * `getMediaTokenSecret()`.
 */
export function signMediaTokenForSession(
	id: string,
	sessionId: string,
	ttlMs: number = MEDIA_TOKEN_TTL_MS,
	now: number = Date.now(),
): string {
	return signMediaToken(
		{ id, sessionId, exp: now + ttlMs },
		getMediaTokenSecret(),
	);
}

/**
 * Verify a token. Returns a discriminated union so callers can branch
 * on the failure reason for telemetry without leaking internals to the
 * client.
 */
export function verifyMediaToken(
	token: string,
	expectedId: string,
	secret: string,
	now: number = Date.now(),
): VerifyMediaTokenResult {
	if (typeof token !== "string" || token.length === 0) {
		return { ok: false, reason: "malformed" };
	}
	const dot = token.indexOf(".");
	if (dot <= 0 || dot === token.length - 1) {
		return { ok: false, reason: "malformed" };
	}
	const bodyEnc = token.slice(0, dot);
	const sigEnc = token.slice(dot + 1);

	const bodyBuf = fromBase64Url(bodyEnc);
	const sigBuf = fromBase64Url(sigEnc);
	if (!bodyBuf || !sigBuf) {
		return { ok: false, reason: "malformed" };
	}

	// Verify signature first (constant time) so we don't leak token
	// structure validity via early returns.
	const expectedSig = hmacSign(secret, bodyEnc);
	if (
		sigBuf.length !== expectedSig.length ||
		!timingSafeEqual(sigBuf, expectedSig)
	) {
		return { ok: false, reason: "bad_signature" };
	}

	let payload: MediaTokenPayload;
	try {
		const decoded = JSON.parse(bodyBuf.toString("utf8")) as unknown;
		if (
			!decoded ||
			typeof decoded !== "object" ||
			typeof (decoded as { id?: unknown }).id !== "string" ||
			typeof (decoded as { sessionId?: unknown }).sessionId !== "string" ||
			typeof (decoded as { exp?: unknown }).exp !== "number" ||
			!Number.isFinite((decoded as { exp: number }).exp)
		) {
			return { ok: false, reason: "malformed" };
		}
		payload = decoded as MediaTokenPayload;
	} catch {
		return { ok: false, reason: "malformed" };
	}

	if (payload.id !== expectedId) {
		return { ok: false, reason: "id_mismatch" };
	}
	if (payload.exp <= now) {
		return { ok: false, reason: "expired" };
	}

	return {
		ok: true,
		id: payload.id,
		sessionId: payload.sessionId,
		exp: payload.exp,
	};
}
