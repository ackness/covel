import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import type { Hono } from "hono";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";
import { __resetUiSpecsCache } from "../../src/routes/misc-api/ui-specs.js";
import { registerTestPlugins } from "../helpers/register-test-plugins.js";

const stubAi = {
  presetRegistry: { listPresets: () => [] },
  gateway: {},
} as unknown as Parameters<typeof createMiscApiRoutes>[0];

const MANIFEST = `---
name: panel-plugin
description: Panel plugin
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
execution: sync
trigger:
  type: manual
ui:
  right:
    - ./ui/panel.json
---
`;

function spec(content: string): string {
  return JSON.stringify({
    id: "panel",
    label: { en: "Panel" },
    view: { component: "Text", props: { content } },
  });
}

describe("GET /api/ui-specs — registry snapshot", () => {
  let dir: string;
  let specPath: string;
  let app: Hono;
  let store: DataStore;
  let registry: PluginRegistry;
  const sessionId = "sess-cache";

  beforeEach(async () => {
    __resetUiSpecsCache();
    dir = await mkdtemp(join(tmpdir(), "covel-uispec-cache-"));
    const pluginDir = join(dir, "panel-plugin");
    await mkdir(join(pluginDir, "ui"), { recursive: true });
    await writeFile(join(pluginDir, "PLUGIN.md"), MANIFEST, "utf-8");
    await writeFile(
      join(pluginDir, "handler.js"),
      "export default async () => ({});",
      "utf-8",
    );
    specPath = join(pluginDir, "ui", "panel.json");
    await writeFile(specPath, spec("v1"), "utf-8");

    store = createMemoryStore();
    registry = createPluginRegistry();
    await registerTestPlugins(registry, [dir]);
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      id: sessionId,
      worldId: null,
      status: "active",
      completedPlayerTurns: 1,
      presetId: null,
      activePlugins: ["panel-plugin"],
      createdAt: new Date().toISOString(),
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
    });
    app = createMiscApiRoutes(stubAi, registry, store);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    __resetUiSpecsCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns static definitions without writing session plugin_data", async () => {
    const setBatch = vi.spyOn(store, "setPluginDataBatch");
    const deleteData = vi.spyOn(store, "deletePluginData");

    const response = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      right: Array<{ pluginId: string; specs: Array<Record<string, unknown>> }>;
    };
    expect(body.right).toEqual([
      expect.objectContaining({ pluginId: "panel-plugin" }),
    ]);
    expect(setBatch).not.toHaveBeenCalled();
    expect(deleteData).not.toHaveBeenCalled();
    await expect(
      store.listPluginData(sessionId, "panel-plugin", "__ui_right__"),
    ).resolves.toEqual([]);
  });

  it("loads assets once for a registry snapshot instead of rescanning each GET", async () => {
    const first = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(JSON.stringify(await first.json())).toContain("v1");

    await writeFile(specPath, spec("v2"), "utf-8");
    const cached = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    const cachedJson = JSON.stringify(await cached.json());
    expect(cachedJson).toContain("v1");
    expect(cachedJson).not.toContain("v2");

    __resetUiSpecsCache();
    const refreshed = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(JSON.stringify(await refreshed.json())).toContain("v2");
  });

  it.each([
    { kind: "file", inside: true },
    { kind: "directory", inside: true },
    { kind: "file", inside: false },
    { kind: "directory", inside: false },
  ])(
    "checks real paths for $kind links (inside=$inside)",
    async ({ kind, inside }) => {
      const pluginDir = join(dir, "panel-plugin");
      const targetDir = join(inside ? pluginDir : dir, "linked-assets");
      await mkdir(targetDir);
      await writeFile(join(targetDir, "panel.json"), spec("linked"), "utf-8");
      await rename(join(pluginDir, "ui"), join(pluginDir, "original-ui"));
      if (kind === "directory") {
        await symlink(targetDir, join(pluginDir, "ui"), "dir");
      } else {
        await mkdir(join(pluginDir, "ui"));
        await symlink(join(targetDir, "panel.json"), specPath, "file");
      }
      registry.register({
        ...registry.get("panel-plugin")!,
        source: "community",
      });
      const logError = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await app.request("/api/ui-specs");
      expect(response.status).toBe(200);
      const body = (await response.json()) as { right: unknown[] };
      if (inside) {
        expect(body.right).toHaveLength(1);
        expect(JSON.stringify(body.right)).toContain("linked");
        expect(logError).not.toHaveBeenCalled();
      } else {
        expect(body.right).toEqual([]);
        expect(logError).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            message: expect.stringContaining("escapes plugin root"),
          }),
        );
      }
    },
  );

  it("preserves client-only component declarations through a linked plugin root", async () => {
    const alias = join(dir, "plugin-alias");
    await symlink(join(dir, "panel-plugin"), alias, "dir");
    const entry = registry.get("panel-plugin")!;
    const parsed = {
      ...entry.manifest!,
      manifest: {
        ...entry.manifest!.manifest,
        ui: { right: ["./ui/client-only.tsx"] },
      },
    };
    registry.register({
      ...entry,
      rootPath: alias,
      manifest: parsed,
      manifests: [parsed],
    });

    const response = await app.request("/api/ui-specs");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      right: [
        {
          pluginId: "panel-plugin",
          specs: [{ _componentPath: "./ui/client-only.tsx" }],
        },
      ],
    });
  });
});
