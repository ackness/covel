/**
 * GET /api/ui-specs — per-spec Zod validation + specVersion.
 *
 * A malformed UI spec must not poison the whole response: the bad spec is
 * dropped from its slot and reported under `diagnostics` with the concrete
 * plugin / field / problem, while sibling specs still render.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function manifest(name: string, specPath: string): string {
  return `---
name: ${name}
description: ${name}
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
execution: sync
trigger:
  type: manual
ui:
  right:
    - ${specPath}
---
`;
}

const GOOD_SPEC = JSON.stringify({
  id: "good",
  label: { zh: "好面板", en: "Good" },
  view: { component: "Text", props: { content: "Hi" } },
});
// No `view` and no `_componentPath` → structural failure.
const NO_VIEW_SPEC = JSON.stringify({ id: "broken", label: { en: "Broken" } });
// specVersion above what the server supports → version failure.
const FUTURE_SPEC = JSON.stringify({
  id: "future",
  specVersion: 99,
  view: { component: "Text" },
});

async function writePlugin(
  root: string,
  id: string,
  specContent: string,
): Promise<void> {
  const dir = join(root, id);
  await mkdir(join(dir, "ui"), { recursive: true });
  await writeFile(
    join(dir, "PLUGIN.md"),
    manifest(id, "./ui/panel.json"),
    "utf-8",
  );
  await writeFile(
    join(dir, "handler.js"),
    "export default async () => ({});",
    "utf-8",
  );
  await writeFile(join(dir, "ui", "panel.json"), specContent, "utf-8");
}

describe("GET /api/ui-specs — per-spec validation", () => {
  let dir: string;
  let app: Hono;
  let store: DataStore;
  let registry: PluginRegistry;
  const sessionId = "sess-validation";

  beforeEach(async () => {
    __resetUiSpecsCache();
    dir = await mkdtemp(join(tmpdir(), "covel-uispec-val-"));

    await writePlugin(dir, "good-panel", GOOD_SPEC);
    await writePlugin(dir, "bad-panel", NO_VIEW_SPEC);
    await writePlugin(dir, "future-panel", FUTURE_SPEC);

    process.env.COVEL_PLUGINS_DIR = dir;
    delete process.env.COVEL_USER_PLUGINS_DIR;

    store = createMemoryStore();
    registry = createPluginRegistry();

    await store.createSession({
      id: sessionId,
      worldId: null,
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      presetId: null,
      activePlugins: ["good-panel", "bad-panel", "future-panel"],
      createdAt: new Date().toISOString(),
    });

    app = createMiscApiRoutes(stubAi, registry, store);
  });

  afterEach(async () => {
    __resetUiSpecsCache();
    delete process.env.COVEL_PLUGINS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("renders valid specs and drops invalid ones with diagnostics", async () => {
    const res = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      right: Array<{ pluginId: string; specs: unknown[] }>;
      diagnostics: Array<{
        pluginId: string;
        slot: string;
        specId?: string;
        issues: Array<{ path: string; message: string }>;
      }>;
    };

    // Only the valid plugin survives in the rendered slot.
    expect(body.right.map((e) => e.pluginId)).toEqual(["good-panel"]);

    // Both bad specs are reported, named, with concrete field-level issues.
    const byPlugin = new Map(body.diagnostics.map((d) => [d.pluginId, d]));
    expect(byPlugin.has("bad-panel")).toBe(true);
    expect(byPlugin.has("future-panel")).toBe(true);

    const missingView = byPlugin.get("bad-panel")!;
    expect(missingView.slot).toBe("right");
    expect(missingView.specId).toBe("broken");
    expect(missingView.issues.some((i) => i.path === "view")).toBe(true);

    const future = byPlugin.get("future-panel")!;
    expect(
      future.issues.some(
        (i) => i.path === "specVersion" && /specVersion/i.test(i.message),
      ),
    ).toBe(true);

    // Invalid plugins never get materialised into plugin_data.
    const badRows = await store.listPluginData(
      sessionId,
      "bad-panel",
      "__ui_right__",
    );
    expect(badRows).toHaveLength(0);
  });

  it("does not report diagnostics for inactive plugins", async () => {
    // Re-scope the session to only the valid plugin; the bad ones are no
    // longer active, so their diagnostics must be filtered out.
    await store.updateSession(sessionId, { activePlugins: ["good-panel"] });
    const res = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    const body = (await res.json()) as {
      right: Array<{ pluginId: string }>;
      diagnostics: Array<{ pluginId: string }>;
    };
    expect(body.right.map((e) => e.pluginId)).toEqual(["good-panel"]);
    expect(body.diagnostics).toHaveLength(0);
  });
});
