import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
import { createHookPipeline, createPluginRpcRegistry } from "@covel/runtime";
import { ToolRegistry } from "@covel/tools";
import { createRpcApprovalGate } from "@covel/approval";
import { discoverAndRegisterPlugins } from "../../src/routes/api/bootstrap/plugin-discovery.js";
import { createBootstrapPluginEntries } from "../../src/routes/api/bootstrap/plugin-entry.js";
import { createRuntimeLoader } from "../../src/routes/api/bootstrap/runtime-loader.js";
import { buildPluginDetail } from "../../src/lib/plugin-descriptor.js";
import { buildUiSpecsResponse } from "../../src/routes/misc-api/ui-specs.js";
import { buildSessionCommandList } from "../../src/routes/api/session/commands.js";
import { createEventDirectory } from "../../src/routes/api/bootstrap/event-directory.js";
import { validatePluginBundle } from "../../src/routes/api/install/plugin-bundle.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "covel-package-declarations-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(relative: string, value: string) {
  const target = path.join(dir, "inspector", relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value, "utf8");
}

const root = `---
name: inspector
description: Shared plugin declarations
version: 1.2.3
capabilities: [fixture-panel]
entry: ./entry.mjs
ui:
  right: [./panel.json]
userSettings:
  - key: mode
    type: text
    label: Mode
    default: shared
dataSchemas:
  records:
    schemaVersion: 1
    schema: ./record.json
    acceptsWorldData: true
worldProjections:
  initial:
    from: geography
    handler: ./project.mjs
    outputs:
      primary:
        namespace: records
        key: initial
commands:
  - name: inspect
    description: Inspect
    action: inspect
events:
  - topic: inspector.changed
    description: A record changed
    schema: ./record.json
    advertise: true
---
`;
const child = `---
name: inspector/check
description: Check shared context
runtimeType: function
handler: ./handler.mjs
trigger:
  type: manual
---
`;

async function seed(withRuntime: boolean) {
  await write("PLUGIN.md", root);
  await write(
    "entry.mjs",
    'export default c => { c.registerRpc("inspect", async () => ({ ok: true })); };',
  );
  await write(
    "panel.json",
    JSON.stringify({
      id: "panel",
      view: { component: "Text", props: { content: "Package UI" } },
    }),
  );
  await write(
    "record.json",
    JSON.stringify({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    }),
  );
  if (withRuntime) {
    await write("runtimes/implementation/PLUGIN.md", child);
    await write(
      "runtimes/implementation/handler.mjs",
      "export default async ctx => ({ effects: [], data: ctx.userSettings });",
    );
  }
  const store = createMemoryStore();
  const discovered = await discoverAndRegisterPlugins({
    pluginsDir: dir,
    eventBus: createEventBus(store),
  });
  return { ...discovered, store };
}

describe("package declarations across framework consumers", () => {
  it.each([false, true])(
    "publishes root declarations with runtime=%s without manufacturing an executor",
    async (withRuntime) => {
      const { registry, store, discoveryMap, manifestCache } =
        await seed(withRuntime);
      const entry = registry.get("inspector")!;
      expect(entry.error).toBeUndefined();
      expect(entry.status).toBe("registered");
      registry.syncSessionActivations("s1", ["inspector"]);
      const runtimes = registry.getActiveRuntimes("s1");
      expect(runtimes).toHaveLength(withRuntime ? 1 : 0);
      expect(registry.findPluginByCapability("s1", "fixture-panel")).toBe(
        "inspector",
      );
      const detail = buildPluginDetail(entry);
      expect(detail).toMatchObject({
        version: "1.2.3",
        runtimeCount: withRuntime ? 1 : 0,
        userSettings: [{ key: "mode", default: "shared" }],
      });
      expect(detail.ui.right).toEqual([{ path: "./panel.json" }]);
      expect(detail.dataSchemas.records).toBeDefined();
      expect(detail.worldProjections.initial).toBeDefined();
      expect(
        buildSessionCommandList(["inspector"], registry).map(
          (command) => command.id,
        ),
      ).toContain("inspector:inspect");
      const ui = await buildUiSpecsResponse({ registry, store });
      expect(ui.right).toHaveLength(1);
      expect(ui.right[0]!.specs).toHaveLength(1);
      expect(ui.diagnostics).toEqual([]);
      const events = createEventDirectory({
        registry,
        resolvePluginDir: () => path.join(dir, "inspector"),
      });
      expect(await events.listTopics("s1")).toEqual(["inspector.changed"]);
      expect(
        await events.validate("s1", "inspector.changed", { value: "ok" }),
      ).toEqual({ ok: true });
      expect(await events.listTopics("inactive")).toEqual([]);
      const rpcRegistry = createPluginRpcRegistry();
      const entries = await createBootstrapPluginEntries({
        discoveryMap,
        manifestCache,
        pluginRegistry: registry,
        store,
        tools: new ToolRegistry(),
        hookPipeline: createHookPipeline(),
        rpcRegistry,
      });
      try {
        expect(
          rpcRegistry.getPluginAction("inspector", "inspect"),
        ).toBeDefined();
        if (withRuntime) {
          expect(runtimes[0]!.capabilities ?? []).not.toContain(
            "fixture-panel",
          );
          expect(runtimes[0]!.userSettings?.[0]?.default).toBe("shared");
          expect(runtimes[0]!.dataSchemas?.records).toBeDefined();
          const loader = createRuntimeLoader({
            pluginRegistry: registry,
            discoveryMap,
            manifestCache,
            store,
            getApprovalGate: () => createRpcApprovalGate(),
          });
          loader.bindPluginEntry(entries.ensurePluginEntry);
          const loaded = await loader.loadRuntimeFn(runtimes[0]!);
          expect(loaded?.manifest.userSettings?.[0]?.default).toBe("shared");
          expect(loaded?.manifest.dataSchemas?.records).toBeDefined();
        }
      } finally {
        await entries.close();
        await store.close();
      }
      expect(
        rpcRegistry.getPluginAction("inspector", "inspect"),
      ).toBeUndefined();
    },
  );

  it("keeps a zero-runtime community entry behind each session's approval", async () => {
    const { registry, store, discoveryMap, manifestCache } = await seed(false);
    const discovery = discoveryMap.get("inspector")!;
    discoveryMap.set("inspector", { ...discovery, source: "community" });
    registry.register({ ...registry.get("inspector")!, source: "community" });
    const approved = new Set<string>();
    const rpcRegistry = createPluginRpcRegistry();
    const entries = await createBootstrapPluginEntries({
      discoveryMap,
      manifestCache,
      pluginRegistry: registry,
      store,
      tools: new ToolRegistry(),
      hookPipeline: createHookPipeline(),
      rpcRegistry,
      isCommunityServerCodeApproved: (sessionId) =>
        Boolean(sessionId && approved.has(sessionId)),
    });
    try {
      expect(entries.hasPendingEntry("inspector")).toBe(true);
      expect(
        rpcRegistry.getPluginAction("inspector", "inspect"),
      ).toBeUndefined();
      await expect(
        entries.ensurePluginEntry("inspector", "s1"),
      ).rejects.toThrow(/approval/);
      approved.add("s1");
      await entries.ensurePluginEntry("inspector", "s1");
      expect(rpcRegistry.getPluginAction("inspector", "inspect")).toBeDefined();
      await expect(
        entries.ensurePluginEntry("inspector", "s2"),
      ).rejects.toThrow(/approval/);
      approved.delete("s1");
      await expect(
        entries.ensurePluginEntry("inspector", "s1"),
      ).rejects.toThrow(/approval/);
    } finally {
      await entries.close();
      await store.close();
    }
  });

  it("rejects conflicting package contributions at install and discovery before publishing capabilities", async () => {
    const conflict = child.replace(
      "---\n",
      "---\nuserSettings:\n  - key: mode\n    type: text\n    label: Mode\n    default: divergent\n",
    );
    const bundle = [
      {
        relativePath: "package.json",
        content: Buffer.from('{"name":"@covel/plugin-inspector"}'),
      },
      { relativePath: "PLUGIN.md", content: Buffer.from(root) },
      {
        relativePath: "runtimes/implementation/PLUGIN.md",
        content: Buffer.from(conflict),
      },
    ];
    expect(() => validatePluginBundle(bundle, new Set())).toThrow(
      /Conflicting userSettings/,
    );
    await write("PLUGIN.md", root);
    await write("runtimes/implementation/PLUGIN.md", conflict);
    const store = createMemoryStore();
    const { registry, discoveryMap, manifestCache } =
      await discoverAndRegisterPlugins({
        pluginsDir: dir,
        eventBus: createEventBus(store),
      });
    expect(registry.get("inspector")?.status).toBe("error");
    expect(discoveryMap.has("inspector")).toBe(false);
    expect(manifestCache.has("inspector")).toBe(false);
    await store.close();
  });
});
