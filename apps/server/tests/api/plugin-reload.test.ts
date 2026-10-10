import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginReloadRoutes } from "../../src/routes/api/plugin-reload.js";
import type { BootstrapPluginEntries } from "../../src/routes/api/bootstrap/plugin-entry.js";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-reload-token");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fixture(development = true) {
  const reload = vi.fn<BootstrapPluginEntries["reload"]>(async (pluginId) => ({
    pluginId,
    generation: "generation-2",
  }));
  const entries: BootstrapPluginEntries = {
    reload,
    close: async () => {},
    watch: () => {},
    hasPendingEntry: () => false,
    isEntryPublished: () => true,
    isEntryRetryDeferred: () => false,
    ensurePluginEntry: async () => {},
    withSnapshot: async (_id, fn) => fn(),
  };
  const app = createPluginReloadRoutes(entries, development);
  const request = (body = "{}", authorized = true) =>
    app.request("/fixture/reload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorized
          ? { Authorization: "Bearer synthetic-reload-token" }
          : {}),
      },
      body,
    });
  return { reload, request };
}

describe("development plugin reload API", () => {
  it("requires operator authorization and development mode before invoking reload", async () => {
    const enabled = fixture();
    expect((await enabled.request("{}", false)).status).toBe(401);
    expect(enabled.reload).not.toHaveBeenCalled();
    const disabled = fixture(false);
    expect((await disabled.request()).status).toBe(403);
    expect(disabled.reload).not.toHaveBeenCalled();
  });
  it("validates input and forwards the selected approval session", async () => {
    const f = fixture();
    expect((await f.request("{broken")).status).toBe(400);
    expect((await f.request('{"sessionId":42}')).status).toBe(400);
    expect(f.reload).not.toHaveBeenCalled();
    const response = await f.request('{"sessionId":"session"}');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      pluginId: "fixture",
      generation: "generation-2",
    });
    expect(f.reload).toHaveBeenCalledWith("fixture", "session");
  });
  it("returns a sanitized rollback failure", async () => {
    const f = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    f.reload.mockRejectedValue(new Error("private factory diagnostic"));
    const response = await f.request();
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("private factory diagnostic");
  });
});
