import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { createMemoryStore } from "@covel/store/memory";
import { createPluginRegistry, parsePluginMd } from "@covel/plugin-loader";
import { PluginServiceRegistry } from "@covel/runtime";
import {
  turnPolicyInputSchema,
  turnPolicyOutputSchema,
  type TurnPolicyOutput,
} from "@covel/shared";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

const originalTier = process.env.DEPLOYMENT_TIER;
afterEach(() => {
  if (originalTier === undefined) delete process.env.DEPLOYMENT_TIER;
  else process.env.DEPLOYMENT_TIER = originalTier;
});
async function fixture() {
  process.env.DEPLOYMENT_TIER = "self";
  const store = createMemoryStore();
  const registry = createPluginRegistry();
  const root = parsePluginMd(
    '---\n{"id":"sample","kind":"plugin","description":"Policy sample","contributes":{"services":[{"contract":"turn-policy@1","modelFacing":true}]}}\n---\n',
    "sample/PLUGIN.md",
  );
  const services = new PluginServiceRegistry({
    list: async () => ["sample"],
    ensure: async () => {},
  });
  for (const name of ["ensemble", "draw"])
    services.register("sample", {
      name,
      contract: "turn-policy@1",
      modelFacing: true,
      description: name,
      input: turnPolicyInputSchema,
      output: turnPolicyOutputSchema,
      handler: (): TurnPolicyOutput => ({
        actors: [],
        order: "sequential",
        narrator: "after",
        yieldHint: "user",
      }),
    });
  registry.register({
    id: "sample",
    source: "builtin",
    packageManifest: root,
    manifests: [],
    loadedRuntimes: new Map(),
    status: "registered",
    summary: {
      id: "sample",
      name: "Policy sample",
      description: "Policy sample",
      kind: "plugin",
      runtimeCount: 0,
    },
  });
  await store.createSession({
    id: "scene",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    seats: [],
    locale: "en-US",
    activePlugins: ["sample"],
    metadata: {
      sessionIncarnationNonce: "incarnation",
      other: "keep",
      ownerTokenHash: createHash("sha256").update("owner").digest("hex"),
    },
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  });
  const app = new Hono();
  const sessionLock = createInProcessSessionLock();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("pluginServices", services);
    c.set("sessionLock", sessionLock);
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  const patch = (body: unknown) =>
    app.request("/api/sessions/scene/orchestration", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { store, app, patch, sessionLock };
}
describe("session orchestration settings", () => {
  it("selects a named policy, preserves metadata and clears back to ambiguity", async () => {
    const { store, app, patch } = await fixture();
    expect(
      await (await app.request("/api/sessions/scene/orchestration")).json(),
    ).toMatchObject({
      status: "ambiguous",
      settings: { maxActors: 4, maxSubagentCalls: 16 },
    });
    expect(
      await (
        await patch({
          turnPolicy: { pluginId: "sample", name: "draw" },
          maxActors: 0,
        })
      ).json(),
    ).toMatchObject({
      status: "selected",
      settings: { maxActors: 0, maxSubagentCalls: 16 },
    });
    expect((await store.getSession("scene"))?.metadata?.other).toBe("keep");
    expect(await (await patch({ turnPolicy: null })).json()).toMatchObject({
      status: "ambiguous",
      settings: { maxActors: 0 },
    });
    await store.close();
  });
  it.each([
    { maxActors: -1 },
    { maxSubagentCalls: 65 },
    { maxActors: 1.5 },
    { extra: true },
    { turnPolicy: { pluginId: "sample", name: "missing" } },
  ])("refuses invalid settings without mutation: %j", async (body) => {
    const { store, patch } = await fixture();
    const before = await store.getSession("scene");
    expect((await patch(body)).status).toBe(400);
    expect(await store.getSession("scene")).toEqual(before);
    await store.close();
  });
  it("retains a stale choice when editing caps and enforces ownership", async () => {
    const { store, app, patch } = await fixture();
    await store.updateSession("scene", {
      metadata: {
        orchestration: { turnPolicy: { pluginId: "removed", name: "Plan" } },
      },
    });
    expect(await (await patch({ maxSubagentCalls: 0 })).json()).toMatchObject({
      status: "missing",
      settings: { turnPolicy: { pluginId: "removed", name: "Plan" } },
    });
    process.env.DEPLOYMENT_TIER = "demo";
    expect((await patch({ maxActors: 1 })).status).toBe(401);
    expect(
      (
        await app.request("/api/sessions/scene/orchestration", {
          headers: { authorization: "Bearer owner" },
        })
      ).status,
    ).toBe(200);
    await store.close();
  });
  it("merges the latest metadata after waiting for another session mutation", async () => {
    const { store, patch, sessionLock } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = sessionLock.withLock("scene", async () => {
      entered();
      await gate;
      await store.updateSession("scene", {
        metadata: {
          concurrentPreference: "keep",
          orchestration: { maxActors: 2 },
        },
      });
    });
    await ready;
    const lock = vi.spyOn(sessionLock, "withLock");
    const response = patch({ maxSubagentCalls: 5 });
    await vi.waitFor(() => expect(lock).toHaveBeenCalled());
    release();
    await held;
    expect((await response).status).toBe(200);
    expect((await store.getSession("scene"))?.metadata).toMatchObject({
      other: "keep",
      concurrentPreference: "keep",
      orchestration: { maxActors: 2, maxSubagentCalls: 5 },
    });
    lock.mockRestore();
    await store.close();
  });
});
