// @vitest-environment node
/**
 * `/api/health` tells a client which deployment form serves it and, when the
 * operator configured it, which source the build came from. The web app uses
 * both for the notice it shows players on a shared server.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { readRuntimeEnv } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import type { StoreBackend } from "@covel/store";
import {
  createHealthRoutes,
  describeHealthSource,
  type HealthSourceInput,
} from "../../src/routes/api/health.js";
import {
  hostProfileMiddleware,
  resolveHostProfile,
} from "../../src/host-profile.js";

async function healthFor(
  vars: Record<string, string>,
  backend: StoreBackend,
  source?: HealthSourceInput,
): Promise<Record<string, unknown>> {
  const profile = resolveHostProfile(readRuntimeEnv(vars), {
    storeBackend: backend,
  });
  const app = new Hono();
  app.use("*", hostProfileMiddleware(profile));
  app.route(
    "/api/health",
    createHealthRoutes(createMemoryStore(), backend, source ? { source } : {}),
  );
  const res = await app.request("/api/health");
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /api/health deployment", () => {
  it("reports a personal host without source details by default", async () => {
    const body = await healthFor({}, "sqlite");
    expect(body.deployment).toEqual({ form: "personal", modelRelay: false });
    expect(body.operatorTokenRequired).toBe(false);
  });

  it("reports the browser-private form, its operator token and the build's source", async () => {
    const body = await healthFor({ NODE_ENV: "production" }, "memory", {
      repository: "https://github.com/ackness/covel/",
      commit: "C1E2867D9",
    });
    expect(body.deployment).toEqual({
      form: "browser-private",
      modelRelay: true,
      source: {
        repository: "https://github.com/ackness/covel",
        commit: "c1e2867d9",
      },
    });
    expect(body.operatorTokenRequired).toBe(true);
    expect(
      (body.storage as { data: { frontendMode: string } }).data.frontendMode,
    ).toBe("local");
  });

  it("reports a hosted tier as hosted", async () => {
    const body = await healthFor(
      {
        DEPLOYMENT_TIER: "demo",
        COVEL_MEDIA_TOKEN_SECRET: "media-secret",
        COVEL_DESKTOP_REST_TOKEN: "operator-secret",
      },
      "sqlite",
    );
    expect(body.deployment).toEqual({ form: "hosted", modelRelay: true });
    expect(body.operatorTokenRequired).toBe(true);
  });
});

describe("describeHealthSource", () => {
  it("keeps only an https repository without credentials and a hex commit", () => {
    expect(
      describeHealthSource({
        repository: "http://github.com/ackness/covel",
        commit: "not-a-commit",
      }),
    ).toBeUndefined();
    expect(
      describeHealthSource({
        repository: "https://user:secret@github.com/ackness/covel",
      }),
    ).toBeUndefined();
    expect(
      describeHealthSource({ repository: "github.com/ackness/covel" }),
    ).toBeUndefined();
    expect(describeHealthSource({ commit: "abc12" })).toBeUndefined();
    expect(describeHealthSource({ commit: " abcdef1 " })).toEqual({
      commit: "abcdef1",
    });
  });

  it("takes RENDER_GIT_COMMIT when COVEL_SOURCE_COMMIT is unset", () => {
    expect(
      readRuntimeEnv({ RENDER_GIT_COMMIT: "0123456789abcdef" }).sourceCommit,
    ).toBe("0123456789abcdef");
    expect(
      readRuntimeEnv({
        RENDER_GIT_COMMIT: "0123456789abcdef",
        COVEL_SOURCE_COMMIT: "fedcba9",
      }).sourceCommit,
    ).toBe("fedcba9");
  });
});
