import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadPluginUiSpecs,
} from "@covel/plugin-loader";

describe("scene-stage dialogue template", () => {
  it("loads the declared dialogue template under segment without diagnostics", async () => {
    const discovery = (
      await discoverPlugins(path.resolve(import.meta.dirname, "../.."))
    ).find(({ id }) => id === "scene-stage");
    const definition = await loadPluginDefinition(discovery);
    const ui = definition.packageManifest.manifest.ui;
    expect(ui.segment).toEqual(["./ui/dialogue-line.json"]);
    const loaded = await loadPluginUiSpecs(
      discovery.rootPath,
      discovery.id,
      ui,
    );
    expect(loaded.diagnostics).toEqual([]);
    const spec = JSON.parse(
      await readFile(
        path.join(discovery.rootPath, "ui/dialogue-line.json"),
        "utf8",
      ),
    );
    expect(loaded.slots.segment).toEqual([spec]);
    expect(spec).toMatchObject({
      match: { kind: "dialogue" },
      view: { component: "Row" },
    });
    expect(spec.view.children[0]).toMatchObject({
      component: "Image",
      visible: { $state: "/visual/avatar" },
      props: { ref: { $state: "/visual/avatar" } },
    });
    expect(spec.view.children[1].children).toEqual([
      { component: "Badge", props: { label: { $state: "/segment/speaker" } } },
      { component: "Prose", props: { content: { $state: "/segment/text" } } },
    ]);
  });
});
