import path from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { createRpcApprovalGate } from "@covel/approval";
import { createPluginRegistry, parsePluginMd } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

it("creates a schema-less portable session with contract data, characters and lore exactly once", async () => {
  const store = createMemoryStore();
  const registry = createPluginRegistry();
  const pluginId = "alternate-clock";
  registry.register({
    id: pluginId,
    source: "builtin",
    status: "registered",
    loadedRuntimes: new Map(),
    manifests: [],
    summary: {
      id: pluginId,
      name: "Clock",
      description: "",
      pluginType: "plugin",
      runtimeCount: 0,
    },
    rootPath: path.resolve(
      import.meta.dirname,
      "../../../../plugins/world-time",
    ),
    packageManifest: parsePluginMd(
      `---
id: alternate-clock
kind: plugin
description: Alternate clock receiver
contracts:
  world.time-definition@1:
    schema: schemas/time-definition.schema.json
contributes:
  data:
    calendars:
      version: 1
      schema: schemas/time-definition.schema.json
      accepts: [world.time-definition@1]
---`,
      "alternate-clock/PLUGIN.md",
    ),
  });
  const definition = {
    id: "world",
    definition: {
      kind: "phases",
      name: "Tides",
      cycleLabel: "Cycle",
      phases: ["High", "Low"],
      initial: { cycle: 1, phase: 0 },
      evolution: { mode: "forward", defaultStep: 1, maxStep: 4 },
    },
  };
  await store.upsertWorld({
    id: "portable",
    name: "Portable",
    description: "",
    createdAt: new Date().toISOString(),
    metadata: {
      source: "server-store",
      contractData: [
        {
          contract: "world.time-definition@1",
          key: "world",
          value: definition,
        },
      ],
      embeddedCharacters: [{ id: "guide", name: "Guide", type: "npc" }],
      embeddedLorebook: [
        { id: "tides", content: "Travel at low tide.", strategy: "constant" },
      ],
    },
  });
  const app = new Hono();
  const lock = createInProcessSessionLock();
  const gate = createRpcApprovalGate();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("sessionLock", lock);
    c.set("rpcApprovalGate", gate);
    c.set("activatePluginServerCode", async () => {});
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  const result = await app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "portable-session",
      worldId: "portable",
      plugins: [pluginId],
    }),
  });
  expect(result.status, await result.text()).toBe(201);
  expect(await store.getCharacterSchema("portable-session")).toBeNull();
  expect(await store.listCharacters("portable-session")).toEqual([
    expect.objectContaining({ id: "portable-session-guide", name: "Guide" }),
  ]);
  expect(await store.listSessionLorebookEntries("portable-session")).toEqual([
    expect.objectContaining({ id: "tides", content: "Travel at low tide." }),
  ]);
  expect(
    (
      await store.getPluginData(
        "portable-session",
        pluginId,
        "calendars",
        "world",
      )
    )?.value,
  ).toEqual(definition);
  expect(
    await store.listWorldDataImportLedger("portable-session"),
  ).toHaveLength(1);
});
