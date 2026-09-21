import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPluginUiSpec } from "@covel/plugin-loader";
import { partitionSlotSpecs } from "../../src/routes/misc-api/ui-spec-schema.js";

function partition(specs: Record<string, unknown>[]) {
  return partitionSlotSpecs({
    specs,
    pluginId: "test-plugin",
    runtimeId: "test-runtime",
    slot: "right",
  });
}

function collectUiJsonFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectUiJsonFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path);
    }
  }
  return files;
}

describe("plugin UI spec validation", () => {
  it("accepts registered components, named slots, and nested repeats", () => {
    const spec = {
      id: "nested-list",
      view: {
        component: "Stack",
        repeat: { statePath: "/groups", key: "id" },
        slots: {
          content: [
            {
              component: "Card",
              repeat: { statePath: { $item: "items" }, key: "id" },
              children: [
                {
                  component: "Button",
                  on: {
                    click: {
                      action: "invokeCommand",
                      params: {
                        command: "roll",
                        args: { sides: { $item: "sides" } },
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    };

    const result = partition([spec]);
    expect(result.valid).toEqual([spec]);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects unknown components with a nested diagnostic path", () => {
    const result = partition([
      {
        id: "bad-component",
        view: {
          component: "Stack",
          slots: { footer: [{ component: "ArbitraryPluginWidget" }] },
        },
      },
    ]);

    expect(result.valid).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      pluginId: "test-plugin",
      runtimeId: "test-runtime",
      slot: "right",
      specId: "bad-component",
    });
    expect(result.diagnostics[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "view.slots.footer.0.component",
        }),
      ]),
    );
  });

  it("rejects malformed graph-bearing fields", () => {
    const result = partition([
      {
        view: {
          component: "Stack",
          children: "not-an-array",
          repeat: { statePath: { $state: "/items" } },
        },
      },
    ]);

    const paths = result.diagnostics[0]?.issues.map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining(["view.children", "view.repeat.statePath"]),
    );
  });

  it.each(["ui/panel.tsx", "ui/panel.js", "ui/panel.txt"])(
    "diagnoses unsupported component files: %s",
    (componentPath) => {
      const result = partition([{ _componentPath: componentPath }]);
      expect(result.valid).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        pluginId: "test-plugin",
        runtimeId: "test-runtime",
        slot: "right",
        issues: [expect.objectContaining({ path: "_componentPath" })],
      });
    },
  );

  it("does not advertise component execution alongside a declarative view", () => {
    const result = partition([
      {
        _componentPath: "ui/panel.js",
        view: { component: "Text", props: { content: "Hello" } },
      },
    ]);
    expect(result.valid).toEqual([]);
    expect(result.diagnostics[0]?.issues[0]?.path).toBe("_componentPath");
  });

  it("accepts every bundled plugin UI spec", async () => {
    const pluginsDirectory = resolve(
      import.meta.dirname,
      "../../../../plugins",
    );
    const uiFiles = readdirSync(pluginsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const uiDirectory = join(pluginsDirectory, entry.name, "ui");
        try {
          return collectUiJsonFiles(uiDirectory);
        } catch {
          return [];
        }
      });

    expect(uiFiles.length).toBeGreaterThan(0);
    const diagnostics = (
      await Promise.all(
        uiFiles.map(async (file) => {
          const spec = await loadPluginUiSpec(pluginsDirectory, file);
          return partition([spec]).diagnostics.map((diagnostic) => ({
            file,
            issues: diagnostic.issues,
          }));
        }),
      )
    ).flat();

    expect(diagnostics).toEqual([]);
  });
});
