import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApplicationWork } from "../../src/application-work.js";
import {
  createAppUpdateRoutes,
  fetchLatestCovelRelease,
} from "../../src/routes/app-update.js";

const ENV_KEYS = ["COVEL_DESKTOP_REST", "COVEL_DESKTOP_REST_TOKEN"] as const;

describe("desktop app update check", () => {
  const savedEnv: Partial<
    Record<(typeof ENV_KEYS)[number], string | undefined>
  > = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("fetches and validates the latest stable GitHub release", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: "v0.0.29",
          name: "Covel v0.0.29",
          published_at: "2026-09-01T08:00:00Z",
          draft: false,
          prerelease: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(fetchLatestCovelRelease(fetchImpl)).resolves.toEqual({
      version: "0.0.29",
      name: "Covel v0.0.29",
      publishedAt: "2026-09-01T08:00:00Z",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/AcKnEsS/covel/releases/latest",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "User-Agent": "Covel-Desktop-Update-Check",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects malformed or prerelease GitHub responses", async () => {
    const invalidTag = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: "nightly",
          published_at: "2026-09-01T08:00:00Z",
          draft: false,
          prerelease: false,
        }),
      ),
    );
    const prerelease = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: "v0.0.29-beta.1",
          published_at: "2026-09-01T08:00:00Z",
          draft: false,
          prerelease: true,
        }),
      ),
    );
    const invalidSemver = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: "v0.0.29-beta.01",
          published_at: "2026-09-01T08:00:00Z",
          draft: false,
          prerelease: false,
        }),
      ),
    );

    await expect(fetchLatestCovelRelease(invalidTag)).rejects.toThrow(
      "response is invalid",
    );
    await expect(fetchLatestCovelRelease(prerelease)).rejects.toThrow(
      "not a stable published release",
    );
    await expect(fetchLatestCovelRelease(invalidSemver)).rejects.toThrow(
      "response is invalid",
    );
  });

  it("does not follow a redirect from the release endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );

    await expect(fetchLatestCovelRelease()).rejects.toThrow(
      /redirect \(HTTP 302\)/,
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  // Real socket cancellation must finish within the host's two-second drain
  // budget, not the update request's ten-second network deadline.
  it.each(["headers", "body"])(
    "cancels an update stalled before %s completion when the host closes",
    async (phase) => {
      process.env.COVEL_DESKTOP_REST = "1";
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const started = Promise.withResolvers<void>();
      const disconnected = Promise.withResolvers<void>();
      const server = createServer((_request, response) => {
        response.once("close", () => disconnected.resolve());
        if (phase === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"tag_name":');
        } else {
          started.resolve();
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP listener");
      }
      const work = createApplicationWork();
      const app = new Hono();
      app.use("*", work.middleware);
      app.route(
        "/",
        createAppUpdateRoutes({
          fetchLatestRelease: (signal) =>
            fetchLatestCovelRelease(async (_url, init) => {
              const response = await fetch(
                `http://127.0.0.1:${address.port}/release`,
                init,
              );
              if (phase === "body") started.resolve();
              return response;
            }, signal),
        }),
      );
      const request = app.request("/api/app-update/latest");
      try {
        await started.promise;
        const [response] = await Promise.all([
          request,
          work.close(),
          disconnected.promise,
        ]);
        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toMatchObject({
          code: "app_update_check_failed",
        });
      } finally {
        server.closeAllConnections();
        const closed = once(server, "close");
        server.close();
        await closed;
        await Promise.all([request, work.close()]);
      }
    },
    2_000,
  );

  it("exposes the check only to an authenticated desktop sidecar", async () => {
    process.env.COVEL_DESKTOP_REST = "1";
    process.env.COVEL_DESKTOP_REST_TOKEN = "desktop-token";
    const fetchLatestRelease = vi.fn().mockResolvedValue({
      version: "0.0.29",
      name: "Covel v0.0.29",
      publishedAt: "2026-09-01T08:00:00Z",
    });
    const app = new Hono();
    app.route("/", createAppUpdateRoutes({ fetchLatestRelease }));

    expect((await app.request("/api/app-update/latest")).status).toBe(401);
    const response = await app.request("/api/app-update/latest", {
      headers: { Authorization: "Bearer desktop-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: "0.0.29",
    });
    expect(fetchLatestRelease).toHaveBeenCalledOnce();
  });

  it("does not expose the GitHub relay outside desktop mode", async () => {
    const fetchLatestRelease = vi.fn();
    const app = new Hono();
    app.route("/", createAppUpdateRoutes({ fetchLatestRelease }));

    const response = await app.request("/api/app-update/latest");

    expect(response.status).toBe(404);
    expect(fetchLatestRelease).not.toHaveBeenCalled();
  });
});
