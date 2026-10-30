/**
 * GET /api/ui-specs serves story paragraph templates declared under
 * `contributes.ui.segment`: filtered by session runnability like message
 * specs, and checked with the segment rules, so a template with no `match`,
 * a webview, plugin data or an action is reported while its valid sibling
 * still loads.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
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

const stubAi = {
  presetRegistry: { listPresets: () => [] },
  gateway: {},
} as unknown as Parameters<typeof createMiscApiRoutes>[0];

const view = {
  component: "Prose",
  props: { content: { $state: "/segment/text" } },
};
const NAMEPLATE = { id: "nameplate", match: { kind: "dialogue" }, view };

interface UiSpecsBody {
  segment: { pluginId: string; specs: Record<string, unknown>[] }[];
  message: { pluginId: string }[];
  diagnostics: {
    pluginId: string;
    slot: string;
    specIndex: number;
    declaredPath?: string;
    issues: { path: string; message: string }[];
  }[];
}

async function writePlugin(
  root: string,
  id: string,
  specs: Record<string, unknown>,
): Promise<void> {
  const dir = join(root, id);
  await mkdir(join(dir, "ui"), { recursive: true });
  const declared = Object.keys(specs)
    .map((name) => `      - ./ui/${name}.json`)
    .join("\n");
  await writeFile(
    join(dir, "PLUGIN.md"),
    `---
id: ${id}
kind: plugin
description: ${id}
contributes:
  ui:
    segment:
${declared}
---
`,
    "utf-8",
  );
  for (const [name, spec] of Object.entries(specs))
    await writeFile(
      join(dir, "ui", `${name}.json`),
      JSON.stringify(spec),
      "utf-8",
    );
}

describe("GET /api/ui-specs — segment templates", () => {
  let dir: string;
  let app: Hono;
  let store: DataStore;
  let registry: PluginRegistry;
  const sessionId = "sess-segment-templates";

  beforeEach(async () => {
    __resetUiSpecsCache();
    dir = await mkdtemp(join(tmpdir(), "covel-uispec-seg-"));
    await writePlugin(dir, "nameplates", { nameplate: NAMEPLATE });
    await writePlugin(dir, "inactive-nameplates", { nameplate: NAMEPLATE });
    await writePlugin(dir, "mixed-templates", {
      nameplate: NAMEPLATE,
      "no-match": { view },
      webview: { match: { kind: "action" }, webview: { entry: "a.html" } },
      "data-source": {
        match: { speaker: "Ana" },
        view,
        dataSource: { namespace: "notes" },
      },
      action: {
        match: { kind: "dialogue" },
        view: { ...view, on: { press: { action: "sendMessage" } } },
      },
    });
    store = createMemoryStore();
    registry = createPluginRegistry();
    await registerTestPlugins(registry, [dir]);
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: sessionId,
      status: "active",
      locale: "en",
      completedPlayerTurns: 1,
      activePlugins: ["nameplates", "mixed-templates"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    app = createMiscApiRoutes(stubAi, registry, store);
  });

  afterEach(async () => {
    __resetUiSpecsCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves segment specs per plugin, filtered by session runnability", async () => {
    const all = (await (
      await app.request("/api/ui-specs")
    ).json()) as UiSpecsBody;
    expect(all.segment.map((entry) => entry.pluginId).sort()).toEqual([
      "inactive-nameplates",
      "mixed-templates",
      "nameplates",
    ]);

    const res = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UiSpecsBody;
    expect(body.message).toEqual([]);
    expect(body.segment.map((entry) => entry.pluginId).sort()).toEqual([
      "mixed-templates",
      "nameplates",
    ]);
    for (const entry of body.segment) expect(entry.specs).toEqual([NAMEPLATE]);
  });

  it("reports rejected templates with their declared path", async () => {
    const body = (await (
      await app.request(`/api/ui-specs?sessionId=${sessionId}`)
    ).json()) as UiSpecsBody;
    const rejected = body.diagnostics.filter(
      (diagnostic) => diagnostic.pluginId === "mixed-templates",
    );
    expect(
      rejected.map(({ slot, specIndex, declaredPath, issues }) => ({
        slot,
        specIndex,
        declaredPath,
        paths: issues.map((issue) => issue.path),
      })),
    ).toEqual([
      {
        slot: "segment",
        specIndex: 1,
        declaredPath: "./ui/no-match.json",
        paths: ["match"],
      },
      {
        slot: "segment",
        specIndex: 2,
        declaredPath: "./ui/webview.json",
        paths: ["webview"],
      },
      {
        slot: "segment",
        specIndex: 3,
        declaredPath: "./ui/data-source.json",
        paths: ["dataSource"],
      },
      {
        slot: "segment",
        specIndex: 4,
        declaredPath: "./ui/action.json",
        paths: ["view.on"],
      },
    ]);
  });
});
