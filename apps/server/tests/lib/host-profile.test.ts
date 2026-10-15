// @vitest-environment node
/**
 * The host profile: the deployment form resolved once at start, its start
 * checks, and the access table every route asks.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { readRuntimeEnv } from "@covel/shared";
import { PERSONAL_PROVIDER_HOST_POLICY } from "@covel/ai-provider";
import type { StoreBackend } from "@covel/store";
import {
  HOST_ACTIONS,
  bindWarnings,
  deriveHostProfile,
  hostProfileMiddleware,
  hostProfileOf,
  requireAccess,
  resolveHostProfile,
  type HostAccessRule,
  type HostAction,
  type HostGlobalAction,
  type HostProfile,
} from "../../src/host-profile.js";

const envFor = (source: Record<string, string>) => readRuntimeEnv(source);

const HOSTED_SECRETS = {
  COVEL_MEDIA_TOKEN_SECRET: "a-real-secret",
  COVEL_DESKTOP_REST_TOKEN: "operator-secret",
};

function profile(
  vars: Record<string, string> = {},
  storeBackend: StoreBackend = "sqlite",
): HostProfile {
  return resolveHostProfile(envFor(vars), { storeBackend });
}

/** Each action's rule as one word: open, owner, token, bearer or closed. */
function table(p: HostProfile): Record<HostAction, string> {
  const word = (rule: HostAccessRule) =>
    rule.kind === "token" && rule.bearerOnly ? "bearer" : rule.kind;
  return Object.fromEntries(
    HOST_ACTIONS.map((action) => [action, word(p.access[action])]),
  ) as Record<HostAction, string>;
}

describe("resolveHostProfile: start checks", () => {
  it("refuses a misspelled tier, naming the variable and the accepted values", () => {
    for (const value of ["slef", "Commercial-typo", "T1", "prod"]) {
      expect(() => envFor({ DEPLOYMENT_TIER: value })).toThrow(
        `Unknown DEPLOYMENT_TIER "${value}". Accepted values: self, demo, commercial.`,
      );
    }
  });

  it("accepts the tier in any case and with spaces around it", () => {
    expect(profile({ DEPLOYMENT_TIER: " Self " }).tier).toBe("self");
    expect(profile({ DEPLOYMENT_TIER: "DEMO", ...HOSTED_SECRETS }).tier).toBe(
      "demo",
    );
  });

  it("starts the self tier with nothing configured", () => {
    expect(profile().form).toBe("personal");
    expect(profile({ DEPLOYMENT_TIER: "self" }).form).toBe("personal");
  });

  it("refuses commercial when secret, CORS, and auth are all missing, listing every problem", () => {
    let message = "";
    try {
      profile({ DEPLOYMENT_TIER: "commercial" });
      expect.unreachable("should have thrown");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("DEPLOYMENT_TIER=commercial");
    expect(message).toContain("COVEL_MEDIA_TOKEN_SECRET");
    expect(message).toContain("CORS_ORIGIN");
    expect(message).toContain("authentication is not configured");
  });

  it("starts commercial when all controls are configured", () => {
    expect(
      profile({
        DEPLOYMENT_TIER: "commercial",
        CORS_ORIGIN: "https://game.example.com",
        ...HOSTED_SECRETS,
      }).form,
    ).toBe("hosted");
  });

  it("requires the media secret and operator token for the demo tier (not CORS)", () => {
    expect(() => profile({ DEPLOYMENT_TIER: "demo" })).toThrow(
      /COVEL_MEDIA_TOKEN_SECRET/,
    );
    // Session creation is operator-gated on hosted tiers, so a demo host
    // without the token could never mint a session — fail at start.
    expect(() =>
      profile({
        DEPLOYMENT_TIER: "demo",
        COVEL_MEDIA_TOKEN_SECRET: "a-real-secret",
      }),
    ).toThrow(/COVEL_DESKTOP_REST_TOKEN/);
    expect(profile({ DEPLOYMENT_TIER: "demo", ...HOSTED_SECRETS }).form).toBe(
      "hosted",
    );
  });

  it.each(["demo", "commercial"])(
    "refuses COVEL_ALLOWED_HOSTS on the %s tier, where the Host check never runs",
    (tier) => {
      expect(() =>
        profile({
          DEPLOYMENT_TIER: tier,
          CORS_ORIGIN: "https://game.example.com",
          COVEL_ALLOWED_HOSTS: "game.example.com",
          ...HOSTED_SECRETS,
        }),
      ).toThrow(/COVEL_ALLOWED_HOSTS has no effect/);
    },
  );

  it("refuses media cleanup on commercial, where the endpoint stays closed", () => {
    expect(() =>
      profile({
        DEPLOYMENT_TIER: "commercial",
        CORS_ORIGIN: "https://game.example.com",
        COVEL_MEDIA_CLEANUP_ENABLED: "1",
        ...HOSTED_SECRETS,
      }),
    ).toThrow(/COVEL_MEDIA_CLEANUP_ENABLED cannot be used/);
    // demo opens it to the operator, and self to the player.
    expect(
      profile({
        DEPLOYMENT_TIER: "demo",
        COVEL_MEDIA_CLEANUP_ENABLED: "1",
        ...HOSTED_SECRETS,
      }).retention.mediaCleanup,
    ).toBe(true);
    expect(
      profile({ COVEL_MEDIA_CLEANUP_ENABLED: "1" }).retention.mediaCleanup,
    ).toBe(true);
  });
});

describe("the access table", () => {
  it("personal: everything open, the self path", () => {
    const p = profile();
    expect(p.form).toBe("personal");
    expect(table(p)).toEqual({
      "session.access": "open",
      "session.create": "open",
      "session.list": "open",
      "world.write": "open",
      "world.generate": "open",
      "plugin.community": "open",
      "server.diagnostics": "open",
      "model.probe": "open",
      "model-db.refresh": "open",
      "server.settings": "open",
      "host.config": "open",
      "host.files": "open",
      "media.cleanup": "open",
      "media.library": "open",
    });
    expect(p.network).toEqual({ checkHost: true, allowedHosts: [] });
    expect(p.credentials).toEqual({
      capabilityOverrides: "full",
      provider: PERSONAL_PROVIDER_HOST_POLICY,
    });
    expect(p.retention).toEqual({
      playerServerSettings: true,
      mediaCleanup: false,
    });
    expect(p.isOperatorToken("anything")).toBe(false);
  });

  it("personal under the desktop shell: its per-launch token guards config and files", () => {
    const p = profile({ COVEL_DESKTOP_REST_TOKEN: "launch-token" });
    expect(p.form).toBe("personal");
    const rules = table(p);
    expect(rules["host.config"]).toBe("bearer");
    expect(rules["host.files"]).toBe("bearer");
    expect(rules["server.settings"]).toBe("bearer");
    expect(rules["session.access"]).toBe("open");
    expect(rules["world.write"]).toBe("open");
    expect(p.isOperatorToken("launch-token")).toBe(true);
  });

  it("personal in production: package writes need COVEL_INSTALL_API_ENABLED", () => {
    expect(table(profile({ NODE_ENV: "production" }))["host.files"]).toBe(
      "closed",
    );
    expect(
      table(
        profile({ NODE_ENV: "production", COVEL_INSTALL_API_ENABLED: "1" }),
      )["host.files"],
    ).toBe("open");
  });

  it("browser-private: owner tokens and operator-only worlds; the other entries as personal (F-005)", () => {
    const p = profile({ NODE_ENV: "production" }, "memory");
    expect(p.form).toBe("browser-private");
    expect(table(p)).toEqual({
      "session.access": "owner",
      "session.create": "open",
      "session.list": "closed",
      "world.write": "token",
      "world.generate": "open",
      "plugin.community": "open",
      "server.diagnostics": "open",
      "model.probe": "open",
      "model-db.refresh": "open",
      "server.settings": "open",
      "host.config": "open",
      "host.files": "closed",
      "media.cleanup": "open",
      "media.library": "closed",
    });
    expect(p.network.checkHost).toBe(true);
    expect(p.credentials.capabilityOverrides).toBe("full");
    expect(p.retention.playerServerSettings).toBe(true);
    // ENABLE_DEBUG_PAGE keeps the listing for the /debug tooling.
    expect(
      table(
        profile({ NODE_ENV: "production", ENABLE_DEBUG_PAGE: "1" }, "memory"),
      )["session.list"],
    ).toBe("open");
  });

  it("a MemoryStore outside production stays personal", () => {
    expect(profile({}, "memory").form).toBe("personal");
  });

  it.each(["demo", "commercial"] as const)(
    "%s: the operator token for every global entry, owner tokens for sessions",
    (tier) => {
      const p = profile({
        DEPLOYMENT_TIER: tier,
        CORS_ORIGIN: "https://game.example.com",
        ...HOSTED_SECRETS,
      });
      expect(p.form).toBe("hosted");
      expect(table(p)).toEqual({
        "session.access": "owner",
        "session.create": "token",
        "session.list": "token",
        "world.write": "token",
        "world.generate": "token",
        "plugin.community": "token",
        "server.diagnostics": "token",
        "model.probe": "token",
        "model-db.refresh": "token",
        "server.settings": "closed",
        "host.config": "bearer",
        "host.files": "bearer",
        "media.cleanup": tier === "commercial" ? "closed" : "token",
        "media.library": "closed",
      });
      expect(p.network.checkHost).toBe(false);
      expect(p.credentials).toEqual({
        capabilityOverrides: "restrict-only",
        provider: { localNetwork: false, sessionlessCommunityWires: false },
      });
      expect(p.retention.playerServerSettings).toBe(false);
      expect(p.isOperatorToken("operator-secret")).toBe(true);
      expect(p.isOperatorToken("operator-secret ")).toBe(false);
    },
  );
});

describe("asking the profile in a request", () => {
  function appFor(p: HostProfile | undefined, action: HostGlobalAction) {
    const app = new Hono();
    if (p) app.use("*", hostProfileMiddleware(p));
    app.get("/probe", (c) => requireAccess(c, action) ?? c.text("ok"));
    return app;
  }
  const demo = () => profile({ DEPLOYMENT_TIER: "demo", ...HOSTED_SECRETS });

  it("takes the operator token from Bearer, X-Session-Token or the query", async () => {
    const app = appFor(demo(), "session.create");
    const refused = await app.request("/probe");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      code: "operator_token_required",
      error: "Operator token required to create sessions on this tier",
    });
    const channels: Record<string, string>[] = [
      { Authorization: "Bearer operator-secret" },
      { "X-Session-Token": "operator-secret" },
    ];
    for (const headers of channels) {
      expect((await app.request("/probe", { headers })).status).toBe(200);
    }
    expect(
      (await app.request("/probe?session_token=operator-secret")).status,
    ).toBe(200);
    expect(
      (
        await app.request("/probe", {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
  });

  it("takes a bearer-only token from Authorization alone", async () => {
    const app = appFor(demo(), "host.files");
    expect(
      (
        await app.request("/probe", {
          headers: { "X-Session-Token": "operator-secret" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/probe", {
          headers: { Authorization: "Bearer operator-secret" },
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a closed action whatever the caller presents", async () => {
    const res = await appFor(demo(), "server.settings").request("/probe", {
      headers: { Authorization: "Bearer operator-secret" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "server_settings_operator_only",
    });
  });

  it("serves the start's profile, not the environment of the request", async () => {
    const p = profile();
    const app = new Hono();
    app.use("*", hostProfileMiddleware(p));
    app.get("/form", (c) => c.text(hostProfileOf(c).form));
    // The environment changing after start does not change the form.
    const before = process.env.DEPLOYMENT_TIER;
    process.env.DEPLOYMENT_TIER = "demo";
    try {
      expect(await (await app.request("/form")).text()).toBe("personal");
    } finally {
      if (before === undefined) delete process.env.DEPLOYMENT_TIER;
      else process.env.DEPLOYMENT_TIER = before;
    }
  });

  it("derives a profile for a route mounted without the composition root", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("storeBackend", "memory");
      await next();
    });
    app.get("/form", (c) => c.text(hostProfileOf(c).form));
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(await (await app.request("/form")).text()).toBe("browser-private");
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe("bindWarnings", () => {
  it("is quiet on loopback", () => {
    expect(bindWarnings(profile(), "127.0.0.1")).toEqual([]);
  });

  it("warns that a personal host on a public bind has no authentication and checks Host names", () => {
    const warnings = bindWarnings(profile(), "0.0.0.0");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("UNAUTHENTICATED");
    expect(warnings[1]).toContain("COVEL_ALLOWED_HOSTS");
  });

  it("does not warn a hosted tier, which authenticates", () => {
    expect(
      bindWarnings(
        profile({ DEPLOYMENT_TIER: "demo", ...HOSTED_SECRETS }),
        "0.0.0.0",
      ),
    ).toEqual([]);
  });
});

describe("deriveHostProfile", () => {
  it("is the pure part: the start checks belong to resolveHostProfile", () => {
    expect(
      deriveHostProfile(envFor({ DEPLOYMENT_TIER: "demo" }), {
        storeBackend: "sqlite",
      }).form,
    ).toBe("hosted");
  });
});
