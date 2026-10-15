/**
 * A confirmed plugin that cannot run now (here: a requirement nobody
 * provides) is off everywhere: no runtime loads, no hook fires, no panel
 * shows, and the plugin list says why.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { LLMAdapter } from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { buildSessionHookScope } from "../../src/routes/api/session/hook-scope.js";
import { buildUiSpecsResponse } from "../../src/routes/misc-api/ui-specs.js";
import { closeTestApi } from "../helpers/close-api.js";

const flag = (pluginId: string) =>
  `__covelUnavailable_${pluginId.replaceAll("-", "_")}`;

function writePlugin(dir: string, pluginId: string, requires: string[]) {
  const root = path.join(dir, pluginId);
  fs.mkdirSync(path.join(root, "ui"), { recursive: true });
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "PLUGIN.md"),
    `---
id: ${pluginId}
kind: plugin
description: unavailable plugin fixture
requires: ${JSON.stringify(requires)}
runtime:
  function:
    handler: ./server/handler.mjs
  schedule:
    trigger:
      type: manual
contributes:
  ui:
    right:
      - ./ui/panel.json
---
`,
  );
  fs.writeFileSync(
    path.join(root, "ui", "panel.json"),
    JSON.stringify({
      id: `${pluginId}-panel`,
      label: { en: pluginId },
      icon: "layout",
      dataSource: { namespace: "entries" },
      view: { component: "Stack", children: [] },
    }),
  );
  fs.writeFileSync(
    path.join(root, "server", "handler.mjs"),
    `globalThis.${flag(pluginId)} = true;\nexport default async function handler() { return { output: { ok: true } }; }\n`,
  );
}

const llm: LLMAdapter = {
  async generate() {
    throw new Error("No model call expected");
  },
};

let root: string;
let boot: ApiBootstrapResult;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-unavailable-"));
  writePlugin(root, "steady", []);
  writePlugin(root, "dependent", ["missing@1"]);
  boot = await bootstrapApi({
    pluginsDir: root,
    pluginsDirs: [root],
    llmAdapter: llm,
    store: createMemoryStore(),
    storeBackend: "memory",
  });
  const now = new Date().toISOString();
  await boot.store.createSession({
    id: "session",
    worldId: "world",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    completedPlayerTurns: 1,
    activePlugins: ["steady", "dependent"],
    locale: "en-US",
    metadata: {
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
    },
    createdAt: now,
    updatedAt: now,
  });
});

afterEach(async () => {
  await closeTestApi(boot);
  await boot.store.close();
  fs.rmSync(root, { recursive: true, force: true });
  const g = globalThis as Record<string, unknown>;
  delete g[flag("steady")];
  delete g[flag("dependent")];
});

it("keeps a plugin whose requirement is missing out of every execution path", async () => {
  const session = (await boot.store.getSession("session"))!;

  const ui = await buildUiSpecsResponse({
    session,
    registry: boot.registry,
    store: boot.store,
  });
  expect(ui.right.map((item) => item.pluginId)).toEqual(["steady"]);

  const scope = buildSessionHookScope({
    pluginRegistry: boot.registry,
    activePluginIds: session.activePlugins,
  });
  expect([...scope.activePluginIds]).toEqual(["steady"]);

  const call = (runtimeId: string) =>
    boot.app.request("/api/sessions/session/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: runtimeId,
        runtimeId,
      }),
    });
  const ran = await call("steady");
  expect(ran.status, await ran.text()).toBe(200);
  const refused = await call("dependent");
  expect(refused.status).toBe(404);
  // Running a turn loads the runnable plugins' code only.
  const g = globalThis as Record<string, unknown>;
  expect(g[flag("steady")]).toBe(true);
  expect(g[flag("dependent")]).toBeUndefined();

  const list = await boot.app.request("/api/sessions/session/plugins");
  const body = (await list.json()) as {
    unavailable: { pluginId: string; reason: string }[];
  };
  expect(body.unavailable).toEqual([
    expect.objectContaining({
      pluginId: "dependent",
      reason: expect.stringContaining("missing@1"),
    }),
  ]);
});
