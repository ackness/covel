import { Hono } from "hono";
import { expect } from "vitest";
import {
  createRpcApprovalGate,
  COMMUNITY_SERVER_CODE_ACTION,
} from "@covel/approval";
import { createPluginFaultLatch } from "@covel/runtime";
import { DIMENSION_DATA_NAMESPACE } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { makeErrorHandler } from "../../src/api-error.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { worldDataSyncRoutes } from "../../src/routes/api/worlds/data-sync.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { datasetWriteFixture } from "./dataset-write-fixture.js";

export const DEPENDENCY_CASES = ["sync-data", "sync-dimensions"].flatMap(
  (endpoint) =>
    ["revoked", "latched", "error"].map((failure) => ({ endpoint, failure })),
);

/** The routes must defer the same writes on every supported database. */
export async function worldDataDependencyScenario(
  store: DataStore,
  { endpoint, failure }: (typeof DEPENDENCY_CASES)[number],
) {
  const fixture = await datasetWriteFixture();
  const gate = createRpcApprovalGate();
  const faults = createPluginFaultLatch();
  const lock = createInProcessSessionLock();
  const app = new Hono();
  app.onError(makeErrorHandler("[world-data-dependencies]", true));
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", fixture.registry);
    c.set("worldsDirs", fixture.options.worldsDirs);
    c.set("rpcApprovalGate", gate);
    c.set("pluginFaults", faults);
    c.set("sessionLock", lock);
    c.set("activatePluginServerCode", async () => {});
    await next();
  });
  app.route("/api/worlds", worldDataSyncRoutes);
  app.route("/api/sessions", sessionRoutes);
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const f = { ...fixture, store, gate, faults, post };
  await store.createWorld({
    id: f.options.worldId,
    name: "Notes",
    description: "Notes",
    createdAt: f.options.now,
  });
  try {
    const original = f.registry.get("probe")!;
    for (const [id, provides, requires] of [
      ["foundation", ["test.foundation@1"], []],
      ["bridge", ["test.bridge@1"], ["test.foundation@1"]],
    ] as const)
      f.registry.register({
        ...original,
        id,
        packageManifest: {
          ...original.packageManifest!,
          plugin: {
            id,
            description: id,
            kind: "plugin",
            provides: [...provides],
            requires: [...requires],
          },
        },
      });
    f.registry.register({
      ...original,
      packageManifest: {
        ...original.packageManifest!,
        plugin: {
          ...original.packageManifest!.plugin,
          provides: ["world.dimensions@1"],
          requires: ["test.bridge@1"],
        },
      },
    });
    const dimensions = (initialValue: number) => ({
      lamp: { name: "Lamp", schema: { type: "number" }, initialValue },
    });
    await f.store.upsertWorld({
      ...(await f.store.getWorld(f.options.worldId))!,
      metadata: { dimensions: dimensions(1) },
    });
    expect(
      (
        await f.post("/api/sessions", {
          id: "s",
          worldId: f.options.worldId,
          plugins: [],
        })
      ).status,
    ).toBe(201);
    const session = (await f.store.getSession("s"))!;
    expect(session.activePlugins).toEqual(
      expect.arrayContaining(["probe", "bridge", "foundation"]),
    );
    const rows = await f.store.listPluginData("s", "probe");
    const ledger = await f.store.listWorldDataImportLedger("s");
    expect(rows.some((row) => row.namespace === DIMENSION_DATA_NAMESPACE)).toBe(
      true,
    );
    if (failure === "revoked") {
      f.registry.register({
        ...f.registry.get("foundation")!,
        source: "community",
      });
      const scope = sessionApprovalScope(session, "foundation");
      const pending = f.gate.evaluate({
        sessionId: "s",
        sessionScope: scope,
        pluginId: "foundation",
        action: COMMUNITY_SERVER_CODE_ACTION,
        payload: {},
        trustLevel: "community",
      });
      expect(pending.status).toBe("pending");
      if (pending.status !== "pending") throw new Error("Approval expected");
      expect(
        f.gate.decide(
          {
            approvalId: pending.approvalId,
            decision: "allow",
            scope: "session",
            decidedAt: f.options.now,
          },
          scope,
        ).ok,
      ).toBe(true);
      expect(f.gate.revoke("s", "foundation")).toBe(1);
    } else if (failure === "latched") {
      for (const key of ["one", "two", "three"])
        f.faults.recordHookFault("s", "foundation", key, "hook");
      expect(f.faults.isLatched("s", "foundation")).toBe(true);
    } else {
      f.registry.register({
        ...f.registry.get("foundation")!,
        status: "error",
        error: "Unavailable",
      });
    }
    await f.records([{ id: "changed", text: "Must stay deferred" }]);
    await f.store.upsertWorld({
      ...(await f.store.getWorld(f.options.worldId))!,
      metadata: { dimensions: dimensions(2) },
    });
    const preflight = await f.post(
      `/api/worlds/${f.options.worldId}/world-data/preflight`,
      { sessionId: "s" },
    );
    expect(preflight.status, await preflight.clone().text()).toBe(200);
    expect((await preflight.json()).targets).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ pluginId: "probe" })]),
    );
    const response = await f.post(
      `/api/worlds/${f.options.worldId}/${endpoint}`,
      { sessionId: "s", dryRun: false },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await f.store.listPluginData("s", "probe")).toEqual(rows);
    expect(await f.store.listWorldDataImportLedger("s")).toEqual(ledger);
  } finally {
    await fixture.cleanup();
  }
}
