/**
 * Boot-time security fail-fast (audit S-13).
 */

import { describe, expect, it } from "vitest";
import { readRuntimeEnv } from "@covel/shared";
import { validateSecurityPosture } from "../../src/security-posture.js";

const envFor = (source: Record<string, string>) => readRuntimeEnv(source);

describe("validateSecurityPosture", () => {
  it("is a no-op for the default self-deploy tier with nothing configured", () => {
    expect(() => validateSecurityPosture(envFor({}))).not.toThrow();
    expect(() =>
      validateSecurityPosture(envFor({ DEPLOYMENT_TIER: "self" })),
    ).not.toThrow();
  });

  it("throws for commercial when secret, CORS, and auth are all missing", () => {
    expect(() =>
      validateSecurityPosture(envFor({ DEPLOYMENT_TIER: "commercial" })),
    ).toThrow(/COVEL_MEDIA_TOKEN_SECRET/);
    try {
      validateSecurityPosture(envFor({ DEPLOYMENT_TIER: "commercial" }));
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("CORS_ORIGIN");
      expect(msg).toContain("authentication is not configured");
    }
  });

  it("passes for commercial when all controls are configured", () => {
    expect(() =>
      validateSecurityPosture(
        envFor({
          DEPLOYMENT_TIER: "commercial",
          COVEL_MEDIA_TOKEN_SECRET: "a-real-secret",
          CORS_ORIGIN: "https://game.example.com",
          COVEL_DESKTOP_REST_TOKEN: "bearer-token",
        }),
      ),
    ).not.toThrow();
  });

  it("requires the media secret and operator token for the demo tier (not CORS)", () => {
    expect(() =>
      validateSecurityPosture(envFor({ DEPLOYMENT_TIER: "demo" })),
    ).toThrow(/COVEL_MEDIA_TOKEN_SECRET/);
    // C-02: session creation is operator-gated on hosted tiers, so a demo
    // host without the token could never mint a session — fail at boot.
    expect(() =>
      validateSecurityPosture(
        envFor({
          DEPLOYMENT_TIER: "demo",
          COVEL_MEDIA_TOKEN_SECRET: "a-real-secret",
        }),
      ),
    ).toThrow(/COVEL_DESKTOP_REST_TOKEN/);
    expect(() =>
      validateSecurityPosture(
        envFor({
          DEPLOYMENT_TIER: "demo",
          COVEL_MEDIA_TOKEN_SECRET: "a-real-secret",
          COVEL_DESKTOP_REST_TOKEN: "bearer-token",
        }),
      ),
    ).not.toThrow();
  });
});
