import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  currentTraceRetention,
  setTraceRetentionPlayerSource,
} from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { makeErrorHandler } from "../../src/api-error.js";
import { createServerSettings } from "../../src/lib/server-settings.js";
import { installTraceRetentionSource } from "../../src/lib/trace-retention-source.js";
import { createServerSettingsRoutes } from "../../src/routes/api/server-settings.js";

const ENV_KEYS = [
  "COVEL_DESKTOP_REST",
  "COVEL_DESKTOP_REST_TOKEN",
  "COVEL_TRACE_RETENTION_DAYS",
  "DEPLOYMENT_TIER",
] as const;
const KEY = "diagnostics.traceRetention";
const PATH = "/api/config/server-settings";

describe("server settings", () => {
  const saved: Record<string, string | undefined> = {};
  let store: ReturnType<typeof createMemoryStore>;
  let clock: number;

  function build() {
    const settings = createServerSettings(store, () => clock);
    const app = new Hono();
    app.onError(makeErrorHandler("[server-settings-test]", false));
    app.route(PATH, createServerSettingsRoutes(settings));
    return { settings, app };
  }

  function put(app: Hono, entries: unknown, headers: HeadersInit = {}) {
    return app.request(PATH, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ entries }),
    });
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    store = createMemoryStore();
    clock = Date.parse("2026-10-10T00:00:00Z");
  });

  afterEach(() => {
    setTraceRetentionPlayerSource(undefined);
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("reports the default as settable on a self deployment without a desktop shell", async () => {
    const { app } = build();
    const res = await app.request(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: { [KEY]: { value: "30", source: "default", settable: true } },
    });
  });

  it("stores a value, answers with it, and the sweep reads it at once", async () => {
    const { app, settings } = build();
    await settings.load();
    installTraceRetentionSource(settings);
    expect(currentTraceRetention()).toEqual({ days: 30, source: "default" });

    const res = await put(app, { [KEY]: "keep" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: { [KEY]: { value: "keep", source: "setting", settable: true } },
    });
    expect(currentTraceRetention()).toEqual({ days: 0, source: "setting" });
    expect(await store.listServerSettings()).toMatchObject([
      { key: KEY, value: "keep" },
    ]);

    // A second server on the same database starts with the stored value.
    const other = build();
    expect(await (await other.app.request(PATH)).json()).toMatchObject({
      settings: { [KEY]: { value: "keep", source: "setting" } },
    });
  });

  it("drops the stored value on null and returns to the default", async () => {
    const { app } = build();
    await put(app, { [KEY]: "7" });
    const res = await put(app, { [KEY]: null });
    expect(await res.json()).toMatchObject({
      settings: { [KEY]: { value: "30", source: "default" } },
    });
    expect(await store.listServerSettings()).toEqual([]);
  });

  it("rejects an unknown key, a value outside the choices and a malformed body, writing nothing", async () => {
    const { app } = build();
    const unknown = await put(app, { [KEY]: "7", "ui.locale": "en-US" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({
      code: "unknown_server_setting",
      details: { key: "ui.locale" },
    });
    const invalid = await put(app, { [KEY]: "12" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: "invalid_server_setting_value",
    });
    const malformed = await app.request(PATH, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [KEY]: "7" }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      code: "invalid_server_settings_body",
    });
    expect(await store.listServerSettings()).toEqual([]);
  });

  it("lets the operator's variable win over the stored value and refuses a write", async () => {
    const { app } = build();
    await put(app, { [KEY]: "7" });
    process.env.COVEL_TRACE_RETENTION_DAYS = "14";
    expect(await (await app.request(PATH)).json()).toEqual({
      settings: { [KEY]: { value: "14", source: "env", settable: false } },
    });
    const res = await put(app, { [KEY]: "90" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "server_setting_fixed" });
    expect(await store.listServerSettings()).toMatchObject([{ value: "7" }]);
  });

  it.each(["demo", "commercial"])(
    "refuses a write on the %s tier even with the operator token, and ignores a stored value",
    async (tier) => {
      await store.setServerSetting({
        key: KEY,
        value: "keep",
        updatedAt: "2026-10-01T00:00:00.000Z",
      });
      process.env.DEPLOYMENT_TIER = tier;
      process.env.COVEL_DESKTOP_REST_TOKEN = "operator-secret";
      const { app } = build();
      const res = await put(
        app,
        { [KEY]: "7" },
        { Authorization: "Bearer operator-secret" },
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: "server_settings_operator_only",
      });
      expect(await (await app.request(PATH)).json()).toEqual({
        settings: {
          [KEY]: { value: "30", source: "default", settable: false },
        },
      });
      expect(await store.listServerSettings()).toMatchObject([
        { value: "keep" },
      ]);
    },
  );

  it("requires the desktop token for a write when the shell set one", async () => {
    process.env.COVEL_DESKTOP_REST_TOKEN = "launch-token";
    const { app } = build();
    expect((await put(app, { [KEY]: "7" })).status).toBe(401);
    expect((await app.request(PATH)).status).toBe(200);
    const res = await put(
      app,
      { [KEY]: "7" },
      { Authorization: "Bearer launch-token" },
    );
    expect(res.status).toBe(200);
  });

  it("follows a value another process wrote once the cached read is stale", async () => {
    const { settings } = build();
    await settings.load();
    await store.setServerSetting({
      key: KEY,
      value: "90",
      updatedAt: "2026-10-10T00:00:01.000Z",
    });
    expect(settings.stored(KEY)).toBeUndefined();
    clock += 31_000;
    settings.stored(KEY);
    await vi.waitFor(() => expect(settings.stored(KEY)).toBe("90"));
  });

  it("keeps the last values when a refresh fails", async () => {
    const { app, settings } = build();
    await put(app, { [KEY]: "7" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const list = vi
      .spyOn(store, "listServerSettings")
      .mockRejectedValue(new Error("database away"));
    clock += 31_000;
    expect(settings.stored(KEY)).toBe("7");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(settings.stored(KEY)).toBe("7");
    list.mockRestore();
    warn.mockRestore();
  });
});
