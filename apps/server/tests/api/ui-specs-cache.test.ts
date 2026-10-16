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
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import type { Hono } from "hono";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";
import { __resetUiSpecsCache } from "../../src/routes/misc-api/ui-specs.js";
import { registerTestPlugins } from "../helpers/register-test-plugins.js";
import { publicSessionIncarnation } from "../../src/routes/api/session/session-guard.js";

const stubAi = {
  presetRegistry: { listPresets: () => [] },
  gateway: {},
} as unknown as Parameters<typeof createMiscApiRoutes>[0];

const MANIFEST = `---
id: panel-plugin
kind: plugin
description: Panel plugin
contributes:
  ui:
    right:
      - ./ui/panel.json
runtime:
  schedule:
    trigger:
      type: manual
  function:
    handler: ./handler.js
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
      status: "active",
      locale: "zh-CN",
      completedPlayerTurns: 1,
      activePlugins: ["panel-plugin"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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

  it("filters activation changes without reloading assets, then reloads on registration", async () => {
    const first = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(JSON.stringify(await first.json())).toContain("v1");
    await writeFile(specPath, spec("v2"), "utf-8");
    const session = (await store.getSession(sessionId))!;
    const incarnation = publicSessionIncarnation(session);
    for (const activePlugins of [[], ["panel-plugin"], []]) {
      await registry.applyPersistedActivations(
        sessionId,
        activePlugins,
        () => store.updateSession(sessionId, { activePlugins }),
        incarnation,
      );
      const response = await app.request(
        `/api/ui-specs?sessionId=${sessionId}`,
      );
      const body = (await response.json()) as { right: unknown[] };
      expect(body.right).toHaveLength(activePlugins.length);
      if (activePlugins.length) {
        expect(JSON.stringify(body)).toContain("v1");
        expect(JSON.stringify(body)).not.toContain("v2");
      }
    }
    registry.register(registry.get("panel-plugin")!);
    const refreshed = await app.request("/api/ui-specs");
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
      const logWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const response = await app.request("/api/ui-specs");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        right: unknown[];
        diagnostics: unknown[];
      };
      if (inside) {
        expect(body.right).toHaveLength(1);
        expect(JSON.stringify(body.right)).toContain("linked");
        expect(logWarn).not.toHaveBeenCalled();
      } else {
        expect(body.right).toEqual([]);
        expect(body.diagnostics).toEqual([
          expect.objectContaining({
            pluginId: "panel-plugin",
            issues: [
              expect.objectContaining({
                message: expect.stringContaining("escapes plugin root"),
              }),
            ],
          }),
        ]);
        expect(logWarn).toHaveBeenCalledWith(
          expect.stringContaining("escapes plugin root"),
        );
      }
    },
  );

  it("keeps JSON UI and diagnoses unsupported components through a linked plugin root", async () => {
    const alias = join(dir, "plugin-alias");
    await symlink(join(dir, "panel-plugin"), alias, "dir");
    const entry = registry.get("panel-plugin")!;
    const parsed = {
      ...entry.packageManifest!,
      manifest: {
        ...entry.packageManifest!.manifest,
        ui: { right: ["./ui/panel.json", "./ui/client-only.tsx"] },
      },
    };
    registry.register({
      ...entry,
      rootPath: alias,
      packageManifest: parsed,
    });

    const response = await app.request("/api/ui-specs");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      right: [
        {
          pluginId: "panel-plugin",
          specs: [{ id: "panel", view: { component: "Text" } }],
        },
      ],
      diagnostics: [
        {
          pluginId: "panel-plugin",
          slot: "right",
          specIndex: 1,
          issues: [
            expect.objectContaining({
              message: expect.stringContaining("custom component files"),
            }),
          ],
        },
      ],
    });
  });
});
