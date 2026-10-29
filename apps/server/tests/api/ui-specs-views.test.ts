import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";
import { registerTestPlugins } from "../helpers/register-test-plugins.js";
import { __resetUiSpecsCache } from "../../src/routes/misc-api/ui-specs.js";

const fixture = path.resolve(
  import.meta.dirname,
  "../../../../tests/third-party/session-view-probe",
);
const stubAi = {
  presetRegistry: { listPresets: () => [] },
  gateway: {},
} as unknown as Parameters<typeof createMiscApiRoutes>[0];
type Response = Awaited<
  ReturnType<
    typeof import("../../src/routes/misc-api/ui-specs.js").buildUiSpecsResponse
  >
>;
describe("GET /api/ui-specs plugin views", () => {
  let root: string;
  let registry: PluginRegistry;
  let store: DataStore;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "covel-ui-views-"));
    await cp(fixture, path.join(root, "session-view-probe"), {
      recursive: true,
    });
    registry = createPluginRegistry();
    store = createMemoryStore();
    await registerTestPlugins(registry, [root]);
  });
  afterEach(async () => {
    __resetUiSpecsCache();
    await rm(root, { recursive: true, force: true });
  });
  async function read(sessionId?: string) {
    const app = createMiscApiRoutes(stubAi, registry, store);
    const response = await app.request(
      `/api/ui-specs${sessionId ? `?sessionId=${sessionId}` : ""}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Response;
  }
  it("lists both views without importing or approving server code", async () => {
    const result = await read();
    expect(result.view).toHaveLength(1);
    expect(result.view[0]?.specs.map((spec) => spec.id)).toEqual([
      "story",
      "notes",
    ]);
    expect(result.view[0]?.specs[0]).toMatchObject({
      bridge: "session",
      webview: { html: expect.stringContaining("covel.subscribe") },
    });
    expect(result.diagnostics).toEqual([]);
  });
  it("always returns a view array, excluding plugins disabled in the session", async () => {
    await store.createSession({
      id: "s",
      status: "active",
      phase: "playing",
      locale: "en-US",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: [],
      createdAt: "2026-10-29",
      updatedAt: "2026-10-29",
    });
    expect((await read("s")).view).toEqual([]);
    await store.updateSession("s", { activePlugins: ["session-view-probe"] });
    expect((await read("s")).view).toHaveLength(1);
  });
  it("keeps the first duplicate view in a package with several runtimes", async () => {
    const dir = path.join(root, "duplicates");
    await mkdir(dir);
    await writeFile(
      path.join(dir, "PLUGIN.md"),
      `---\nid: duplicates\ndescription: Duplicate views\ncontributes:\n  ui:\n    view: [./first.json, ./second.json]\n---\n`,
    );
    for (const id of ["one", "two"]) {
      const runtime = path.join(dir, "runtimes", id);
      await mkdir(runtime, { recursive: true });
      await writeFile(
        path.join(runtime, "RUNTIME.md"),
        `---\ndescription: Test\nschedule: { trigger: { type: manual } }\n---\nTest.`,
      );
    }
    for (const name of ["first", "second"])
      await writeFile(
        path.join(dir, `${name}.json`),
        JSON.stringify({
          id: "reader",
          label: name,
          view: { component: "Text" },
        }),
      );
    await registerTestPlugins(registry, [root]);
    const result = await read();
    expect(
      result.view.find((entry) => entry.pluginId === "duplicates")?.specs,
    ).toEqual([expect.objectContaining({ label: "first" })]);
    expect(
      result.diagnostics.filter((item) => item.pluginId === "duplicates"),
    ).toEqual([
      expect.objectContaining({
        slot: "view",
        specId: "reader",
        issues: [
          {
            path: "id",
            message: 'duplicate view id "reader"',
            code: "invalid",
          },
        ],
      }),
    ]);
  });
  it("reports a broken view while leaving the same plugin's right panel usable", async () => {
    const dir = path.join(root, "broken");
    await mkdir(dir);
    await writeFile(
      path.join(dir, "PLUGIN.md"),
      `---\nid: broken\ndescription: Broken view\ncontributes:\n  ui:\n    right: [./panel.json]\n    view: [./bad.json]\n---\n`,
    );
    await writeFile(
      path.join(dir, "panel.json"),
      JSON.stringify({ view: { component: "Text" } }),
    );
    await writeFile(
      path.join(dir, "bad.json"),
      JSON.stringify({ view: { component: "Text" }, bridge: "session" }),
    );
    await registerTestPlugins(registry, [root]);
    const result = await read();
    expect(result.right.some((entry) => entry.pluginId === "broken")).toBe(
      true,
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: "broken",
        slot: "view",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "bridge" }),
          expect.objectContaining({ path: "id" }),
        ]),
      }),
    );
  });
});

it("projects multi-file view URLs and diagnoses root in right panels", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-ui-page-projection-"));
  try {
    const plugin = path.join(root, "page");
    await mkdir(path.join(plugin, "ui/app"), { recursive: true });
    await writeFile(
      path.join(plugin, "PLUGIN.md"),
      "---\nid: page\ndescription: Page\ncontributes:\n  ui:\n    view: [./view.json]\n    right: [./right.json]\n---\n",
    );
    const webview = { root: "./ui/app", entry: "index.html" };
    await writeFile(
      path.join(plugin, "view.json"),
      JSON.stringify({ id: "page", label: "Page", webview }),
    );
    await writeFile(
      path.join(plugin, "right.json"),
      JSON.stringify({ label: "Right", webview }),
    );
    await writeFile(path.join(plugin, "ui/app/index.html"), "<head></head>");
    const registry = createPluginRegistry();
    await registerTestPlugins(registry, [root]);
    const app = createMiscApiRoutes(stubAi, registry, createMemoryStore());
    const result = (await (
      await app.request("/api/ui-specs")
    ).json()) as Response;
    expect(result.view[0]?.specs[0]?.webview).toEqual({
      url: expect.stringMatching(
        /^\/plugin-assets\/page\/[a-f0-9]{32}\/index.html$/,
      ),
    });
    expect(result.right).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        slot: "right",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "webview.root",
            message: "webview.root is only valid in contributes.ui.view",
          }),
        ]),
      }),
    );
  } finally {
    __resetUiSpecsCache();
    await rm(root, { recursive: true, force: true });
  }
});
