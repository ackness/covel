/**
 * Community HTTP permission fail-closed matrix (03 §4 groundwork).
 *
 * A community plugin's `ctx.utils.fetchWithRetry` may only reach an
 * origin+method it declared under `permissions.http`; anything else is rejected
 * before the request is sent. Trusted (builtin/official) plugins are not
 * enforced. The SSRF guard is unaffected — it still runs inside the wrapped
 * `fetchWithRetry` for permitted origins.
 */

import { describe, it, expect, vi } from "vitest";
import type { PluginRuntimeUtils } from "@covel/plugin-loader";
import type { HttpPermissionDecl } from "@covel/shared";
import { enforceHttpPermissions } from "../src/function-runtime/http-permissions.js";

function mockUtils(): {
  utils: PluginRuntimeUtils;
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
  return {
    fetch,
    utils: {
      validateBaseUrl: () => ({ ok: true }),
      fetchWithRetry: fetch as unknown as PluginRuntimeUtils["fetchWithRetry"],
    },
  };
}

const perms: readonly HttpPermissionDecl[] = [
  { origin: "https://api.example.com", methods: ["GET", "POST"] },
  { origin: "https://data.example.com" }, // methods default to GET only
];

describe("enforceHttpPermissions (community)", () => {
  it("allows a declared origin + method through to the underlying utils", async () => {
    const { utils, fetch } = mockUtils();
    const guarded = enforceHttpPermissions(utils, {
      isCommunity: true,
      httpPermissions: perms,
      runtimeId: "p/rt",
    });
    await guarded.fetchWithRetry("https://api.example.com/v1/x", {
      method: "POST",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("defaults an omitted request method to GET (declared origin allows it)", async () => {
    const { utils, fetch } = mockUtils();
    const guarded = enforceHttpPermissions(utils, {
      isCommunity: true,
      httpPermissions: perms,
      runtimeId: "p/rt",
    });
    await guarded.fetchWithRetry("https://data.example.com/thing");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects an undeclared origin without calling the underlying fetch", async () => {
    const { utils, fetch } = mockUtils();
    const guarded = enforceHttpPermissions(utils, {
      isCommunity: true,
      httpPermissions: perms,
      runtimeId: "p/rt",
    });
    await expect(
      guarded.fetchWithRetry("https://evil.example.net/steal"),
    ).rejects.toThrow(/http permission denied/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a declared origin with an undeclared method (POST to a GET-only origin)", async () => {
    const { utils, fetch } = mockUtils();
    const guarded = enforceHttpPermissions(utils, {
      isCommunity: true,
      httpPermissions: perms,
      runtimeId: "p/rt",
    });
    await expect(
      guarded.fetchWithRetry("https://data.example.com/x", { method: "POST" }),
    ).rejects.toThrow(/http permission denied/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects when the plugin declares no http permissions at all", async () => {
    const { utils, fetch } = mockUtils();
    const guarded = enforceHttpPermissions(utils, {
      isCommunity: true,
      httpPermissions: [],
      runtimeId: "p/rt",
    });
    await expect(
      guarded.fetchWithRetry("https://api.example.com/x"),
    ).rejects.toThrow(/http permission denied/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("enforceHttpPermissions (trusted builtin/official)", () => {
  it("does not enforce — returns the utils unchanged so any origin passes", async () => {
    const { utils, fetch } = mockUtils();
    const guarded = enforceHttpPermissions(utils, {
      isCommunity: false,
      httpPermissions: [], // no declarations, yet trusted calls still pass
      runtimeId: "core/rt",
    });
    expect(guarded).toBe(utils); // unchanged reference
    await guarded.fetchWithRetry("https://anywhere.example.net/x", {
      method: "DELETE",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
