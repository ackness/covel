// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";

const fakes = vi.hoisted(() => ({
  store: vi.fn(),
  media: vi.fn(),
  pool: vi.fn(),
  bootstrap: vi.fn(),
  seed: vi.fn(),
  watcher: vi.fn(),
  mountApiRoutes: vi.fn(),
}));

vi.mock("@covel/store/factory", () => ({
  createStoreFromEnv: fakes.store,
  createMediaStoreFromEnv: fakes.media,
  resolveBackendFromEnv: () => "memory",
}));
vi.mock("postgres", () => ({ default: fakes.pool }));
vi.mock("../../src/ai-setup.js", () => ({
  createAiStack: () => ({ gateway: {} }),
}));
vi.mock("../../src/routes/api/bootstrap.js", () => ({
  bootstrapApi: fakes.bootstrap,
}));
vi.mock("../../src/world-seed-reconcile.js", () => ({
  seedAndReconcileWorlds: fakes.seed,
}));
vi.mock("../../src/world-file-watcher.js", () => ({
  createWorldFileWatcher: fakes.watcher,
}));
vi.mock("../../src/host-routes.js", () => ({
  mountApiRoutes: fakes.mountApiRoutes,
}));

describe("app.ts CORS sidecarOrigins scoping", () => {
  let home: string;
  let drain: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    vi.resetModules();
    Object.values(fakes).forEach((mock) => mock.mockReset());
    home = await mkdtemp(join(tmpdir(), "covel-app-cors-"));
    vi.stubEnv("COVEL_HOME", home);
    vi.stubEnv("COVEL_USER_WORLDS_DIR", join(home, "user-worlds"));
    vi.stubEnv("COVEL_USER_PLUGINS_DIR", join(home, "user-plugins"));
    vi.stubEnv("PORT", "3001");
    vi.stubEnv("CORS_ORIGIN", "https://game.example.com");
    vi.spyOn(console, "log").mockImplementation(() => {});

    fakes.store.mockResolvedValue(createMemoryStore());
    fakes.media.mockResolvedValue({ close: async () => {} });
    fakes.bootstrap.mockResolvedValue({
      trustedSources: { verifyAll: async () => {} },
      runtimeJobWorker: { close: async () => {} },
      startupMaintenance: Promise.resolve(),
      closePluginEntries: async () => {},
      closeTools: async () => {},
      eventBus: { close: async () => {} },
    });
    fakes.seed.mockResolvedValue(undefined);
    fakes.watcher.mockReturnValue({ start() {}, stop: async () => {} });
    fakes.mountApiRoutes.mockImplementation((app: Hono) => {
      app.get("/api/ping", (c) => c.json({ ok: true }));
      app.post("/api/ping", (c) => c.json({ ok: true }, 201));
    });
  });

  afterEach(async () => {
    if (drain) {
      await drain();
      drain = undefined;
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it.each(["demo", "commercial"] as const)(
    "does not allow loopback sidecar origins on DEPLOYMENT_TIER=%s",
    async (tier) => {
      vi.stubEnv("DEPLOYMENT_TIER", tier);
      vi.stubEnv("COVEL_MEDIA_TOKEN_SECRET", "a-real-secret");
      vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "operator-secret");

      const mod = await import("../../src/app.js");
      drain = mod.drainServerResources;

      for (const sidecarOrigin of [
        "http://127.0.0.1:3001",
        "http://localhost:3001",
      ]) {
        const getRes = await mod.app.request(
          "https://game.example.com/api/ping",
          {
            headers: { Origin: sidecarOrigin },
          },
        );
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get("access-control-allow-origin")).toBeNull();

        const postRes = await mod.app.request(
          "https://game.example.com/api/ping",
          {
            method: "POST",
            headers: {
              Origin: sidecarOrigin,
              "Content-Type": "text/plain",
            },
            body: "{}",
          },
        );
        expect(postRes.status).toBe(403);
        expect(await postRes.json()).toMatchObject({
          code: "origin_not_allowed",
        });
      }

      const allowedRes = await mod.app.request(
        "https://game.example.com/api/ping",
        { headers: { Origin: "https://game.example.com" } },
      );
      expect(allowedRes.status).toBe(200);
      expect(allowedRes.headers.get("access-control-allow-origin")).toBe(
        "https://game.example.com",
      );
    },
    60_000,
  );

  it("keeps loopback sidecar origins allowed on DEPLOYMENT_TIER=self even when CORS_ORIGIN is pinned", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "self");

    const mod = await import("../../src/app.js");
    drain = mod.drainServerResources;

    for (const sidecarOrigin of [
      "http://127.0.0.1:3001",
      "http://localhost:3001",
    ]) {
      const res = await mod.app.request("http://127.0.0.1:3001/api/ping", {
        headers: { Origin: sidecarOrigin },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        sidecarOrigin,
      );
    }
  }, 60_000);
});
