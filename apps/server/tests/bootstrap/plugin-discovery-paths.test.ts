import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
import { discoverAndRegisterPlugins } from "../../src/routes/api/bootstrap/plugin-discovery.js";
import { buildPluginFlowResponse } from "../../src/routes/misc-api/plugin-flow.js";
import {
  pluginRuntimeDirectory,
  pluginRuntimeDocumentPath,
} from "../../src/routes/misc-api/registry-projection.js";
import { buildUiSpecsResponse } from "../../src/routes/misc-api/ui-specs.js";

describe("registry runtime discovery paths", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "covel-runtime-paths-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    { id: "single", runtimes: [{ name: "single", directory: "" }] },
    {
      id: "qualified",
      runtimes: [{ name: "qualified/manual", directory: "" }],
    },
    {
      id: "multiple",
      runtimes: [
        { name: "multiple/first", directory: "runtimes/first" },
        { name: "multiple/second", directory: "runtimes/second" },
      ],
    },
  ])("projects actual discovered paths for $id", async ({ id, runtimes }) => {
    for (const runtime of runtimes) {
      const runtimeDir = path.join(dir, id, runtime.directory);
      await mkdir(path.join(runtimeDir, "ui"), { recursive: true });
      await writeFile(
        path.join(runtimeDir, "PLUGIN.md"),
        `---
name: ${runtime.name}
description: Runtime path fixture
runtimeType: function
handler: ./handler.js
trigger:
  type: manual
ui:
  right:
    - ./ui/panel.json
---
`,
        "utf-8",
      );
      await writeFile(
        path.join(runtimeDir, "ui", "panel.json"),
        JSON.stringify({
          id: runtime.name,
          view: { component: "Text", props: { content: runtime.name } },
        }),
        "utf-8",
      );
    }

    const store = createMemoryStore();
    const { registry } = await discoverAndRegisterPlugins({
      pluginsDir: dir,
      eventBus: createEventBus(store),
    });
    const entry = registry.get(id)!;
    expect(entry.status).toBe("registered");
    const flow = buildPluginFlowResponse(registry);
    for (const runtime of runtimes) {
      const runtimeDir = path.join(dir, id, runtime.directory);
      const manifestPath = path.join(runtimeDir, "PLUGIN.md");
      expect(entry.runtimeManifestPaths?.[runtime.name]).toBe(manifestPath);
      expect(pluginRuntimeDirectory(entry, runtime.name)).toBe(runtimeDir);
      expect(pluginRuntimeDocumentPath(entry, runtime.name)).toBe(manifestPath);
      expect(
        flow.steps.find((step) => step.runtimeId === runtime.name)?.docPath,
      ).toBe(path.posix.join("plugins", id, runtime.directory, "PLUGIN.md"));
    }
    expect(pluginRuntimeDirectory(entry, `${id}/unknown`)).toBeUndefined();
    expect(pluginRuntimeDocumentPath(entry, `${id}/unknown`)).toBeUndefined();

    const response = await buildUiSpecsResponse({ registry, store });
    expect(response.right).toEqual([
      {
        pluginId: id,
        specs: runtimes.map((runtime) => ({
          id: runtime.name,
          view: { component: "Text", props: { content: runtime.name } },
        })),
      },
    ]);
    expect(response.diagnostics).toEqual([]);
  });
});
