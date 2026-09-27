import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRpcApprovalGate } from "@covel/approval";
import { createPluginRegistry, parsePluginMd } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

function fixture(conflicts: boolean) {
  const registry = createPluginRegistry();
  for (const id of ["default", "first", "second"]) {
    const root = parsePluginMd(
      `---\n${JSON.stringify({ id, kind: id === "default" ? "core" : "plugin", description: id, provides: id === "default" ? [{ contract: "allocation@1", default: true }] : ["allocation@1"], ...(conflicts ? { conflicts: ["allocation@1"] } : {}), runtime: { type: "agent", schedule: { stage: "setup" }, io: { output: { contract: "allocation@1" } } } })}\n---\n`,
      `${id}/PLUGIN.md`,
    );
    registry.register({
      id,
      summary: {
        id,
        name: id,
        description: id,
        pluginType: id === "default" ? "core-plugin" : "plugin",
        runtimeCount: 1,
      },
      packageManifest: root,
      manifest: root,
      manifests: [root],
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
  const create = (id: string, plugins: string[]) =>
    app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, plugins }),
    });
  return { registry, store, app, create };
}
describe("runtime provider selection", () => {
  it("rejects conflicting explicit requests without persisting a session", async () => {
    const { create, store } = fixture(true);
    const response = await create("ambiguous", ["first", "second"]);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.text()).toContain("Conflict");
    expect(await store.getSession("ambiguous")).toBeNull();
  });
  it("activates ordinary multiple providers and suppresses only the default", async () => {
    const { create, store, registry } = fixture(false);
    const response = await create("multiple", ["first", "second"]);
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await store.getSession("multiple"))?.activePlugins).toEqual([
      "first",
      "second",
    ]);
    expect(
      registry.getActiveRuntimes("multiple").map((runtime) => runtime.name),
    ).toEqual(["first", "second"]);
  });
  it("enables an explicit replacement and restores the prior request after it is excluded", async () => {
    const { create, app, store } = fixture(true);
    expect((await create("session", ["first"])).status).toBe(201);
    const enabled = await app.request("/api/sessions/session/plugins/second", {
      method: "PUT",
    });
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    expect((await store.getSession("session"))?.activePlugins).toEqual([
      "second",
    ]);
    const disabled = await app.request("/api/sessions/session/plugins/second", {
      method: "DELETE",
    });
    expect(disabled.status).toBe(200);
    expect((await store.getSession("session"))?.activePlugins).toEqual([
      "first",
    ]);
    expect(
      (await store.getSession("session"))?.metadata?.pluginSelection,
    ).toEqual({ requested: ["first"], excluded: ["second"] });
  });
});
