import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
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
