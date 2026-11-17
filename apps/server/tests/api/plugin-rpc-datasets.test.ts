import { readRuntimeEnv } from "@covel/shared";
import { mintSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";
import {
  hostProfileMiddleware,
  resolveHostProfile,
} from "../../src/host-profile.js";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store/memory";
import { MAX_PLUGIN_DATA_VALUE_BYTES } from "@covel/shared";
import { pluginDataRoutes } from "../../src/routes/api/plugin-data.js";
import { makeErrorHandler } from "../../src/api-error.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { datasetWriteFixture } from "../helpers/dataset-write-fixture.js";

async function setup() {
  const fixture = await datasetWriteFixture();
  const store = createMemoryStore();
  await store.createSession({
    ...fixture.session(),
    metadata: {
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
    },
  });
  const lock = createInProcessSessionLock();
  const app = new Hono();
  app.onError(makeErrorHandler("[dataset-test]", false));
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", fixture.registry);
    c.set("sessionLock", lock);
    await next();
  });
  app.route("/api/sessions", pluginDataRoutes);
  return {
    ...fixture,
    app,
    store,
    close: async () => {
      await store.close();
      await fixture.cleanup();
    },
  };
}

describe("management dataset overrides", () => {
  it("requires the session owner for management overrides on a hosted instance", async () => {
    const f = await setup();
    try {
      f.policy(["inc"]);
      const owner = mintSessionOwnerToken();
      await f.store.updateSession(f.options.sessionId, {
        metadata: { ownerTokenHash: owner.tokenHash },
      });
      const app = new Hono();
      app.use(
        "*",
        hostProfileMiddleware(
          resolveHostProfile(
            readRuntimeEnv({
              DEPLOYMENT_TIER: "demo",
              COVEL_MEDIA_TOKEN_SECRET: "test-media-secret",
              COVEL_DESKTOP_REST_TOKEN: "test-operator-secret",
            }),
            { storeBackend: "memory" },
          ),
        ),
      );
      const lock = createInProcessSessionLock();
      app.use("*", async (c, next) => {
        c.set("store", f.store);
        c.set("pluginRegistry", f.options.preflight.registry);
        c.set("sessionLock", lock);
        await next();
      });
      app.route("/api/sessions", pluginDataRoutes);
      const url = `/api/sessions/${f.options.sessionId}/plugin-data/probe/notes/key`;
      const put = (token?: string) =>
        app.request(url, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ value: { invalid: true } }),
        });
      expect((await put()).status).toBe(401);
      expect((await put("wrong-token")).status).toBe(401);
      expect((await put(owner.token)).status).toBe(200);
      expect((await app.request(url, { method: "DELETE" })).status).toBe(401);
      expect(
        (
          await app.request(url, {
            method: "DELETE",
            headers: { authorization: `Bearer ${owner.token}` },
          })
        ).status,
      ).toBe(200);
    } finally {
      await f.close();
    }
  });

  it("keeps management PUT and DELETE as authorized overrides with existing size and namespace limits", async () => {
    const f = await setup();
    try {
      f.policy(["inc"]);
      const base = `/api/sessions/${f.options.sessionId}/plugin-data/probe`;
      const put = (namespace: string, value: unknown) =>
        f.app.request(`${base}/${namespace}/key`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value }),
        });
      expect((await put("notes", { invalid: true })).status).toBe(200);
      expect(
        (
          await f.store.getPluginData(
            f.options.sessionId,
            "probe",
            "notes",
            "key",
          )
        )?.value,
      ).toEqual({ invalid: true });
      expect(
        (await f.app.request(`${base}/notes/key`, { method: "DELETE" })).status,
      ).toBe(200);
      expect(
        (await put("notes", "x".repeat(MAX_PLUGIN_DATA_VALUE_BYTES))).status,
      ).toBe(413);
      expect((await put("_hidden.notes", {})).status).toBe(403);
      await f.store.updateSession(f.options.sessionId, { activePlugins: [] });
      expect((await put("notes", {})).status).toBe(403);
    } finally {
      await f.close();
    }
  });
});
