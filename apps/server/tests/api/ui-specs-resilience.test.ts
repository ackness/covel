/**
 * Regression (2026-06-28): a single plugin whose runtime fails to load (e.g. a
 * corrupt UI spec JSON) must NOT 500 the whole `/api/ui-specs` response. It is
 * logged with context and skipped; healthy plugins still resolve. This mirrors
 * the boot-time eager-load try/catch — the asymmetry where boot tolerated a bad
 * runtime but the request path did not was why every world 500'd on open.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
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

const stubAi = {
  presetRegistry: { listPresets: () => [] },
  gateway: {},
} as unknown as Parameters<typeof createMiscApiRoutes>[0];

const manifestFor = (name: string): string => `---
name: ${name}
description: test
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
trigger:
  type: manual
ui:
  right:
    - ./ui/panel.json
---
`;

const GOOD_SPEC = JSON.stringify({
  id: "good",
  label: { zh: "好", en: "Good" },
  view: { component: "Text", props: { content: "Hi" } },
});

async function writePlugin(
  root: string,
  id: string,
  specContent: string,
): Promise<void> {
  const dir = join(root, id);
  await mkdir(join(dir, "ui"), { recursive: true });
  await writeFile(join(dir, "PLUGIN.md"), manifestFor(id), "utf-8");
  await writeFile(
    join(dir, "handler.js"),
    "export default async () => ({});",
    "utf-8",
  );
  await writeFile(join(dir, "ui", "panel.json"), specContent, "utf-8");
}

describe("GET /api/ui-specs — one bad runtime must not 500 the whole response", () => {
  let dir: string;
  let app: Hono;
  let store: DataStore;
  let registry: PluginRegistry;
  const sessionId = "sess-resilience";

  beforeEach(async () => {
    __resetUiSpecsCache();
    dir = await mkdtemp(join(tmpdir(), "covel-resilience-"));
    await writePlugin(dir, "good-plugin", GOOD_SPEC);
    // Corrupt UI spec JSON → loadRuntime throws while reading ui/panel.json.
    await writePlugin(dir, "broken-plugin", "{ this is not valid json");

    process.env.COVEL_PLUGINS_DIR = dir;
    store = createMemoryStore();
    registry = createPluginRegistry();
    await store.createSession({
      id: sessionId,
      worldId: null,
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      presetId: null,
      activePlugins: ["good-plugin", "broken-plugin"],
      createdAt: new Date().toISOString(),
    });
    app = createMiscApiRoutes(stubAi, registry, store);
  });

  afterEach(async () => {
    __resetUiSpecsCache();
    delete process.env.COVEL_PLUGINS_DIR;
    delete process.env.COVEL_USER_PLUGINS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns 200 with the healthy plugin and skips + logs the broken one", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await app.request(`/api/ui-specs?sessionId=${sessionId}`);

    expect(res.status).toBe(200); // NOT 500
    const body = (await res.json()) as {
      right: Array<{ pluginId: string }>;
    };
    const ids = body.right.map((e) => e.pluginId);
    expect(ids).toContain("good-plugin");
    expect(ids).not.toContain("broken-plugin");

    // The failure was logged with the offending plugin/runtime for triage.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("broken-plugin"),
      expect.anything(),
    );
    errSpy.mockRestore();
  });
});
