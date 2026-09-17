import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRpcApprovalGate } from "@covel/approval";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

describe("runtime provider selection", () => {
  it("rejects conflicts on creation and enable without persisting an ambiguous session", async () => {
    const registry = createPluginRegistry();
    for (const id of ["default", "default-alt", "first", "second"]) {
      const manifest = {
        name: id,
        pluginId: id,
        description: id,
        stage: "setup" as const,
        capabilities: ["allocation"],
        ...(id.startsWith("default") ? { fallbackFor: "allocation" } : {}),
      };
      registry.register({
        id,
        summary: {
          id,
          name: id,
          description: id,
          pluginType: id === "default" ? "core-plugin" : "plugin",
          runtimeCount: 1,
        },
        manifest: { manifest, promptTemplate: "", rawFrontmatter: {} },
        loadedRuntimes: new Map(),
        status: "registered",
        source: "builtin",
      });
    }
    const store = createMemoryStore();
    const app = new Hono();
    const gate = createRpcApprovalGate();
    const lock = createInProcessSessionLock();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      c.set("rpcApprovalGate", gate);
      c.set("sessionLock", lock);
      await next();
    });
    app.route("/api/sessions", sessionRoutes);
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "ambiguous",
        plugins: ["default", "first", "second"],
      }),
    });
    expect(created.status, await created.clone().text()).toBe(400);
    expect(await created.text()).toContain("Multiple active providers");
    expect(await store.getSession("ambiguous")).toBeNull();
    await store.createSession({
      id: "session",
      worldId: null,
      phase: "setup",
      status: "active",
      completedPlayerTurns: 0,
      activePlugins: ["default", "first"],
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const enabled = await app.request("/api/sessions/session/plugins/second", {
      method: "PUT",
    });
    expect(enabled.status, await enabled.clone().text()).toBe(400);
    expect((await store.getSession("session"))?.activePlugins).toEqual([
      "default",
      "first",
    ]);
    const competingDefault = await app.request(
      "/api/sessions/session/plugins/default-alt",
      { method: "PUT" },
    );
    expect(competingDefault.status).toBe(400);

    // A session accepted by an older build must remain recoverable, but disabling
    // its replacement must not persist an ambiguous active runtime set.
    await store.updateSession("session", {
      activePlugins: ["default", "default-alt", "first"],
    });
    const invalidDisable = await app.request(
      "/api/sessions/session/plugins/first",
      { method: "DELETE" },
    );
    expect(invalidDisable.status).toBe(400);
    expect((await store.getSession("session"))?.activePlugins).toEqual([
      "default",
      "default-alt",
      "first",
    ]);
    const removeConflict = await app.request(
      "/api/sessions/session/plugins/default-alt",
      { method: "DELETE" },
    );
    expect(removeConflict.status).toBe(200);
    const restoreDefault = await app.request(
      "/api/sessions/session/plugins/first",
      { method: "DELETE" },
    );
    expect(restoreDefault.status).toBe(200);
    expect((await store.getSession("session"))?.activePlugins).toEqual([
      "default",
    ]);
  });
});
