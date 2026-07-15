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

  it("requires only the media secret for the demo tier", () => {
    expect(() =>
      validateSecurityPosture(envFor({ DEPLOYMENT_TIER: "demo" })),
    ).toThrow(/COVEL_MEDIA_TOKEN_SECRET/);
    expect(() =>
      validateSecurityPosture(
        envFor({
          DEPLOYMENT_TIER: "demo",
          COVEL_MEDIA_TOKEN_SECRET: "a-real-secret",
        }),
      ),
    ).not.toThrow();
  });
});
