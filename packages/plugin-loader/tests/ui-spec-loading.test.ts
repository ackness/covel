import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadRuntime,
  loadPluginUiSpecs,
  type PluginDiscoveryResult,
} from "../src/index.js";

async function loadUi(discovery: PluginDiscoveryResult) {
  const { packageManifest } = await loadPluginDefinition(discovery);
  return loadPluginUiSpecs(
    discovery.rootPath,
    discovery.id,
    packageManifest.manifest.ui,
  );
}

describe("UI spec loading", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-ui-test-"));

    // Plugin with UI specs
    const pluginDir = path.join(tmpDir, "test-ui-plugin");
    await fs.mkdir(path.join(pluginDir, "ui"), { recursive: true });

    await fs.writeFile(
      path.join(pluginDir, "PLUGIN.md"),
      `---
id: test-ui-plugin
kind: plugin
description: Plugin with UI specs
runtime: {schedule: {stage: narrative}}
contributes:
  ui:
    right: [./ui/panel.json]
    message: [./ui/block.json]
---

Test prompt.
`,
    );

    await fs.writeFile(
      path.join(pluginDir, "ui", "panel.json"),
      JSON.stringify({
        id: "test-panel",
        label: { zh: "测试面板", en: "Test Panel" },
        icon: "layout",
        dataSource: { namespace: "entries" },
        view: { component: "Stack", children: [] },
      }),
    );

    await fs.writeFile(
      path.join(pluginDir, "ui", "block.json"),
      JSON.stringify({
        id: "test-block",
        trigger: "test-discovery",
        view: { component: "Card", children: [] },
      }),
    );

    // Plugin without UI
    const noUiDir = path.join(tmpDir, "no-ui-plugin");
    await fs.mkdir(noUiDir, { recursive: true });
    await fs.writeFile(
      path.join(noUiDir, "PLUGIN.md"),
      `---
id: no-ui-plugin
kind: plugin
description: No UI
runtime: {schedule: {stage: narrative}}
---

Prompt.
`,
    );

    // Plugin with UI specs AND a function handler whose module import has a
    // visible side effect — used to pin that loadPluginUiSpecs never runs plugin JS.
    const handlerDir = path.join(tmpDir, "ui-handler-plugin");
    await fs.mkdir(path.join(handlerDir, "ui"), { recursive: true });
    await fs.writeFile(
      path.join(handlerDir, "PLUGIN.md"),
      `---
id: ui-handler-plugin
kind: plugin
description: UI plus handler
runtime:
  schedule: {stage: narrative}
  function: {handler: ./handler.mjs}
contributes:
  ui:
    right: [./ui/panel.json]
---

Prompt.
`,
    );
    await fs.writeFile(
      path.join(handlerDir, "ui", "panel.json"),
      JSON.stringify({ id: "handler-panel", view: { component: "Text" } }),
    );
    await fs.writeFile(
      path.join(handlerDir, "handler.mjs"),
      `globalThis.__covelUiHandlerImported = true;
export default async function handler() { return { proposals: [] }; }
`,
    );

    // Plugin with path traversal attack
    const evilDir = path.join(tmpDir, "evil-plugin");
    await fs.mkdir(evilDir, { recursive: true });
    await fs.writeFile(
      path.join(evilDir, "PLUGIN.md"),
      `---
id: evil-plugin
kind: plugin
description: Evil
runtime: {schedule: {stage: narrative}}
contributes:
  ui:
    right: [../outside.json]
---

Prompt.
`,
    );
    await fs.writeFile(
      path.join(tmpDir, "outside.json"),
      JSON.stringify({ view: { component: "Text" } }),
    );
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__covelUiHandlerImported;
  });

  it("should parse ui field from PLUGIN.md frontmatter", async () => {
    const discoveries = await discoverPlugins(tmpDir);
    const discovery = discoveries.find((d) => d.id === "test-ui-plugin");
    expect(discovery).toBeDefined();

    const { packageManifest } = await loadPluginDefinition(discovery!);
    expect(packageManifest.manifest.ui).toBeDefined();
    expect(packageManifest.manifest.ui?.right).toEqual(["./ui/panel.json"]);
    expect(packageManifest.manifest.ui?.message).toEqual(["./ui/block.json"]);
  });

  it("should load package UI specs independently of execution", async () => {
    const discoveries = await discoverPlugins(tmpDir);
    const discovery = discoveries.find((d) => d.id === "test-ui-plugin")!;
    const loaded = await loadUi(discovery);

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.slots.right).toHaveLength(1);
    expect(loaded.slots.right?.[0]!.id).toBe("test-panel");
    expect(loaded.slots.right?.[0]!.icon).toBe("layout");
    expect(loaded.slots.message).toHaveLength(1);
    expect(loaded.slots.message?.[0]!.id).toBe("test-block");
  });

  it("should handle plugin with no ui field", async () => {
    const discoveries = await discoverPlugins(tmpDir);
    const discovery = discoveries.find((d) => d.id === "no-ui-plugin")!;

    expect(await loadUi(discovery)).toEqual({ slots: {}, diagnostics: [] });
  });

  it("does not read a spec outside the plugin root", async () => {
    const discoveries = await discoverPlugins(tmpDir);
    const discovery = discoveries.find((d) => d.id === "evil-plugin")!;

    const loaded = await loadUi(discovery);
    expect(loaded.slots).toEqual({});
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        slot: "right",
        specIndex: 0,
        issues: [
          expect.objectContaining({ message: "UI asset escapes plugin root" }),
        ],
      }),
    ]);
  });

  it("loadPluginUiSpecs returns UI specs without importing handler JS", async () => {
    const discoveries = await discoverPlugins(tmpDir);
    const discovery = discoveries.find((d) => d.id === "ui-handler-plugin")!;

    const loaded = await loadUi(discovery);

    expect(loaded.slots.right?.[0]!.id).toBe("handler-panel");
    // The handler module's import side effect must NOT have run.
    expect(
      (globalThis as Record<string, unknown>).__covelUiHandlerImported,
    ).toBeUndefined();

    // Contrast: the full execution loader does import it.
    await loadRuntime(discovery, "ui-handler-plugin");
    expect(
      (globalThis as Record<string, unknown>).__covelUiHandlerImported,
    ).toBe(true);
  });
});

describe("view spec loading", () => {
  it("keeps the first view id and loads right panels despite invalid views", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "covel-view-list-"));
    const root = path.join(parent, "owner");
    await fs.mkdir(root);
    try {
      for (const [file, spec] of Object.entries({
        "first.json": {
          id: "reader",
          label: "First",
          view: { component: "Text" },
        },
        "second.json": {
          id: "reader",
          label: "Second",
          view: { component: "Text" },
        },
        "invalid.json": { view: { component: "Text" } },
        "right.json": { view: { component: "Text" } },
      }))
        await fs.writeFile(path.join(root, file), JSON.stringify(spec));
      const result = await loadPluginUiSpecs(root, "owner", {
        view: ["first.json", "second.json", "invalid.json"],
        right: ["right.json"],
      });
      expect(result.slots.view).toHaveLength(1);
      expect(result.slots.view?.[0]?.label).toBe("First");
      expect(result.slots.right).toHaveLength(1);
      expect(result.diagnostics).toHaveLength(2);
      expect(result.diagnostics[0]).toMatchObject({
        slot: "view",
        specIndex: 1,
        specId: "reader",
        issues: [{ path: "id", message: 'duplicate view id "reader"' }],
      });
      expect(result.diagnostics[1]?.issues.map((issue) => issue.path)).toEqual([
        "id",
        "label",
      ]);
      await fs.writeFile(
        path.join(root, "PLUGIN.md"),
        `---
id: owner
description: View validation
contributes:
  ui:
    view: [./first.json, ./second.json]
---
`,
      );
      let stderr = "";
      expect(
        await runValidateManifest([root], {
          stdout: { write: () => {} },
          stderr: {
            write: (text) => {
              stderr += text;
            },
          },
        }),
      ).toBe(1);
      expect(stderr).toContain(
        'contributes.ui.view: ./second.json: id: duplicate view id "reader"',
      );
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
