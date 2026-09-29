import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import { discoverAndRegisterPlugins } from "../../src/routes/api/bootstrap/plugin-discovery.js";
import { buildPluginFlowResponse } from "../../src/routes/misc-api/plugin-flow.js";
import {
  pluginRuntimeDirectory,
  pluginRuntimeDocumentPath,
} from "../../src/routes/misc-api/registry-projection.js";
import { stringify } from "yaml";
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
      runtimes: [{ name: "qualified/manual", directory: "runtimes/manual" }],
    },
    {
      id: "multiple",
      runtimes: [
        { name: "multiple/first", directory: "runtimes/first" },
        { name: "multiple/second", directory: "runtimes/second" },
      ],
    },
  ])("projects actual discovered paths for $id", async ({ id, runtimes }) => {
    const rootPath = path.join(dir, id);
    await mkdir(rootPath, { recursive: true });
    const runtimeDeclaration = {
      type: "function",
      function: { handler: "./handler.js" },
      schedule: { trigger: { type: "manual" } },
    };
    await writeFile(
      path.join(rootPath, "PLUGIN.md"),
      `---\n${stringify({
        id,
        kind: "plugin",
        description: "Runtime path fixture",
        contributes: {
          ui: {
            right: runtimes.map(
              (runtime) =>
                `./${runtime.directory ? runtime.directory + "/" : ""}ui/panel.json`,
            ),
          },
        },
        ...(runtimes[0]!.directory === ""
          ? { runtime: runtimeDeclaration }
          : {}),
      })}---\n`,
    );
    for (const runtime of runtimes) {
      const runtimeDir = path.join(rootPath, runtime.directory);
      await mkdir(path.join(runtimeDir, "ui"), { recursive: true });
      if (runtime.directory)
        await writeFile(
          path.join(runtimeDir, "RUNTIME.md"),
          `---\n${stringify(runtimeDeclaration)}---\n`,
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
      const documentName = runtime.directory ? "RUNTIME.md" : "PLUGIN.md";
      const manifestPath = path.join(runtimeDir, documentName);
      expect(entry.runtimeManifestPaths?.[runtime.name]).toBe(manifestPath);
      expect(pluginRuntimeDirectory(entry, runtime.name)).toBe(runtimeDir);
      expect(pluginRuntimeDocumentPath(entry, runtime.name)).toBe(manifestPath);
      expect(
        flow.steps.find((step) => step.runtimeId === runtime.name)?.docPath,
      ).toBe(path.posix.join("plugins", id, runtime.directory, documentName));
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
