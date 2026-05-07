/**
 * Unit tests for the media-token HMAC middleware.
 *
 * Covers SPEC §5.1 (g):
 *   - sign/verify round-trip
 *   - expired tokens
 *   - tampered signature
 *   - id mismatch (token issued for one asset replayed against another)
 *   - malformed input
 *   - dev-mode random secret bootstrapping + production fail-fast
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  MEDIA_TOKEN_TTL_MS,
  _resetMediaTokenSecretForTests,
  getMediaTokenSecret,
  signMediaToken,
  signMediaTokenForSession,
  verifyMediaToken,
} from "../../src/middleware/media-token.js";

const FIXED_NOW = 1_700_000_000_000;
const TEST_SECRET = "test-secret-" + "a".repeat(40);

describe("media-token signMediaToken / verifyMediaToken", () => {
  it("verifies a freshly signed token with matching id", () => {
    const token = signMediaToken(
      { id: "sha-abc", sessionId: "sess-1", exp: FIXED_NOW + 60_000 },
      TEST_SECRET,
    );
    const verdict = verifyMediaToken(token, "sha-abc", TEST_SECRET, FIXED_NOW);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.id).toBe("sha-abc");
      expect(verdict.sessionId).toBe("sess-1");
      expect(verdict.exp).toBe(FIXED_NOW + 60_000);
    }
  });

  it("rejects an expired token", () => {
    const token = signMediaToken(
      { id: "sha-abc", sessionId: "sess-1", exp: FIXED_NOW - 1 },
      TEST_SECRET,
    );
    const verdict = verifyMediaToken(token, "sha-abc", TEST_SECRET, FIXED_NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("expired");
    }
  });

  it("rejects a tampered signature", () => {
    const token = signMediaToken(
      { id: "sha-abc", sessionId: "sess-1", exp: FIXED_NOW + 60_000 },
      TEST_SECRET,
    );
    const dot = token.indexOf(".");
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    // Flip a single byte deterministically.
    const tampered = body + "." + (sig[0] === "A" ? "B" : "A") + sig.slice(1);

    const verdict = verifyMediaToken(
      tampered,
      "sha-abc",
      TEST_SECRET,
      FIXED_NOW,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("bad_signature");
    }
  });

  it("rejects a token whose embedded id does not match the URL parameter", () => {
    const token = signMediaToken(
      { id: "sha-abc", sessionId: "sess-1", exp: FIXED_NOW + 60_000 },
      TEST_SECRET,
    );
    const verdict = verifyMediaToken(
      token,
      "sha-other",
      TEST_SECRET,
      FIXED_NOW,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("id_mismatch");
    }
  });

  it.each([
    ["empty string", ""],
    ["no separator", "just-some-base64url-string"],
    ["leading separator", ".sig"],
    ["trailing separator", "body."],
    ["non-base64 chars", "body!.sig?"],
  ])("rejects malformed token: %s", (_label, raw) => {
    const verdict = verifyMediaToken(raw, "sha-abc", TEST_SECRET, FIXED_NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("malformed");
    }
  });

  it("rejects a body whose JSON does not match the schema", () => {
    // Hand-craft a token whose payload lacks `sessionId`.
    const evilBody = Buffer.from(
      JSON.stringify({ id: "sha-abc", exp: FIXED_NOW + 60_000 }),
      "utf8",
    ).toString("base64url");
    // Compute a real signature so the failure mode is "malformed" not
    // "bad_signature".
    const sig = createHmac("sha256", TEST_SECRET)
      .update(evilBody)
      .digest("base64url");
    const token = `${evilBody}.${sig}`;

    const verdict = verifyMediaToken(token, "sha-abc", TEST_SECRET, FIXED_NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("malformed");
    }
  });

  it("signMediaTokenForSession applies the default 5-minute TTL", () => {
    const tok = signMediaTokenForSession(
      "sha-abc",
      "sess-1",
      undefined,
      FIXED_NOW,
    );
    // Verify just-in-time before expiry.
    const verdict = verifyMediaToken(
      tok,
      "sha-abc",
      getMediaTokenSecret(),
      FIXED_NOW + MEDIA_TOKEN_TTL_MS - 1,
    );
    expect(verdict.ok).toBe(true);
    // And just past expiry.
    const expired = verifyMediaToken(
      tok,
      "sha-abc",
      getMediaTokenSecret(),
      FIXED_NOW + MEDIA_TOKEN_TTL_MS + 1,
    );
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toBe("expired");
  });
});

describe("getMediaTokenSecret", () => {
  const ORIGINAL = process.env.COVEL_MEDIA_TOKEN_SECRET;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.COVEL_MEDIA_TOKEN_SECRET;
    process.env.NODE_ENV = "development";
    _resetMediaTokenSecretForTests();
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.COVEL_MEDIA_TOKEN_SECRET;
    } else {
      process.env.COVEL_MEDIA_TOKEN_SECRET = ORIGINAL;
    }
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
    _resetMediaTokenSecretForTests();
    warnSpy.mockRestore();
  });

  it("reads COVEL_MEDIA_TOKEN_SECRET from environment when set", () => {
    process.env.COVEL_MEDIA_TOKEN_SECRET = "configured-secret";
    expect(getMediaTokenSecret()).toBe("configured-secret");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("generates a per-process random secret in dev when env var missing, and warns once", () => {
    const a = getMediaTokenSecret();
    const b = getMediaTokenSecret();
    expect(a).toBe(b); // same secret across calls within the process
    expect(a.length).toBeGreaterThan(20);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("throws in production when env var missing", () => {
    process.env.NODE_ENV = "production";
    _resetMediaTokenSecretForTests();
    expect(() => getMediaTokenSecret()).toThrow(/COVEL_MEDIA_TOKEN_SECRET/);
  });
});
