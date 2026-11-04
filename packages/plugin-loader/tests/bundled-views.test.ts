import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveI18nText, pluginUiSpecIssues } from "@covel/shared";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadPluginUiSpecs,
} from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../../plugins");
async function load(id: string) {
  const discovery = (await discoverPlugins(root)).find(
    (item) => item.id === id,
  )!;
  const definition = await loadPluginDefinition(discovery);
  const ui = await loadPluginUiSpecs(
    discovery.rootPath,
    id,
    definition.packageManifest.manifest.ui,
  );
  return { definition, ui };
}

describe("bundled session view declarations", () => {
  it.each([["dm-console", "dm-console", "DM Console", "主持人控制台"]])(
    "loads the real %s view with English and Chinese labels",
    async (id, viewId, en, zh) => {
      const { ui } = await load(id);
      expect(ui.diagnostics).toEqual([]);
      const spec = ui.slots.view?.[0];
      if (!spec) throw new Error(`${id} declares no view`);
      expect(spec.id).toBe(viewId);
      expect(
        resolveI18nText(
          spec.label as Parameters<typeof resolveI18nText>[0],
          "en-US",
        ),
      ).toBe(en);
      expect(
        resolveI18nText(
          spec.label as Parameters<typeof resolveI18nText>[0],
          "zh-CN",
        ),
      ).toBe(zh);
      expect(pluginUiSpecIssues(spec, id, "view")).toEqual([]);
      for (const field of [
        "group",
        "groupOrder",
        "groupLabel",
        "shortLabel",
        "surfaces",
        "navTarget",
        "bridge",
        "webview",
      ])
        expect(spec).not.toHaveProperty(field);
      expect(spec.alwaysRender).toBe(true);
    },
  );
  it.each(["npc-graph", "codex"])(
    "%s keeps its right panel and declares no duplicate page",
    async (id) => {
      const { ui } = await load(id);
      expect(ui.diagnostics).toEqual([]);
      expect(ui.slots.view).toBeUndefined();
      expect(ui.slots.right).toHaveLength(1);
    },
  );
  it("is a zero-runtime package with no hard dependency or entry", async () => {
    const { definition, ui } = await load("dm-console");
    expect(definition.manifests).toEqual([]);
    const manifest = definition.packageManifest.manifest;
    expect(manifest.entry).toBeUndefined();
    expect(definition.packageManifest.plugin.requires ?? []).toEqual([]);
    expect(ui.slots.right).toBeUndefined();
    expect(JSON.stringify(ui)).not.toContain("invokeRuntime");
  });
  it("loads the same widgets for a community package without importing its entry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "community-view-"));
    try {
      await fs.writeFile(
        path.join(dir, "entry.mjs"),
        "throw new Error('entry must not run');",
      );
      await fs.writeFile(
        path.join(dir, "PLUGIN.md"),
        "---\nid: community-console\ndescription: Community console\nentry: ./entry.mjs\ncontributes:\n  ui:\n    view: [./console.json]\n---\n",
      );
      await fs.writeFile(
        path.join(dir, "console.json"),
        JSON.stringify({
          id: "console",
          label: "Community console",
          alwaysRender: true,
          view: {
            type: "Stack",
            children: [
              { type: "SessionMessages" },
              { type: "SessionComposer" },
            ],
          },
        }),
      );
      const ui = await loadPluginUiSpecs(dir, "community-console", {
        view: ["./console.json"],
      });
      expect(ui.diagnostics).toEqual([]);
      expect(ui.slots.view?.[0]?.label).toBe("Community console");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

it("keeps session region selectors literal when the same visible text has a translation", async () => {
  const { compileUiText, missingTranslations } =
    await import("../src/locale-messages.js");
  const spec = {
    id: "desk",
    label: "Desk",
    view: {
      component: "Stack",
      slots: {
        body: [
          { type: "SessionMessages", props: { content: "pending" } },
          { component: "Text", props: { content: "pending" } },
        ],
      },
    },
  };
  const translated = compileUiText(spec, [
    {
      locale: "zh",
      file: "locales/zh.yaml",
      messages: { pending: "待处理", Desk: "工作台" },
    },
  ]);
  expect(translated.view.slots.body[0]!.props.content).toBe("pending");
  expect(translated.view.slots.body[1]!.props.content).toEqual({
    en: "pending",
    zh: "待处理",
  });
  expect(pluginUiSpecIssues(translated, "community", "view")).toEqual([]);
  expect(
    await missingTranslations(path.join(root, "dm-console"), "zh"),
  ).toEqual([]);
});
