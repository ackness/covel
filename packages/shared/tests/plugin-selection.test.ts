import { describe, expect, it } from "vitest";
import { resolvePluginSelection } from "../src/plugin-selection.js";

type SelectablePlugin = Parameters<
  typeof resolvePluginSelection
>[0]["plugins"][number];

function plugin(
  id: string,
  overrides: Partial<Omit<SelectablePlugin, "id">> = {},
): SelectablePlugin {
  return { id, pluginType: "plugin", source: "builtin", ...overrides };
}

describe("resolvePluginSelection", () => {
  it("expands runtime-qualified dependencies by package and terminates cycles", () => {
    const plugins = [
      plugin("story", {
        relations: { requires: ["memory/read", "memory/write"] },
      }),
      plugin("memory", { relations: { requires: ["story/narrate"] } }),
    ];

    expect(
      resolvePluginSelection({
        activePluginIds: ["story"],
        requestedPluginIds: ["story"],
        plugins,
      }),
    ).toEqual(["story", "memory"]);
  });

  it.each(["current", "requested"] as const)(
    "prioritizes the new request when only the %s plugin declares the conflict",
    (conflictOwner) => {
      const plugins = [
        plugin(
          "current",
          conflictOwner === "current"
            ? { relations: { conflicts: ["requested"] } }
            : {},
        ),
        plugin(
          "requested",
          conflictOwner === "requested"
            ? { relations: { conflicts: ["current"] } }
            : {},
        ),
      ];

      expect(
        resolvePluginSelection({
          activePluginIds: ["current", "requested"],
          requestedPluginIds: ["requested"],
          plugins,
        }),
      ).toEqual(["requested"]);
    },
  );

  it.each([
    {
      source: "builtin",
      provides: "narrative-engine",
      expected: ["replacement"],
    },
    { source: "community", provides: "narrative-engine", expected: ["core"] },
    { source: "builtin", provides: "unrelated-engine", expected: ["core"] },
  ] as const)(
    "checks source=$source and provides=$provides before replacing protected core",
    ({ source, provides, expected }) => {
      const plugins = [
        plugin("core", {
          pluginType: "core-plugin",
          relations: { provides: ["narrative-engine"] },
        }),
        plugin("replacement", {
          source,
          relations: { provides: [provides], conflicts: ["core"] },
        }),
      ];

      expect(
        resolvePluginSelection({
          activePluginIds: ["replacement"],
          requestedPluginIds: ["replacement"],
          plugins,
        }),
      ).toEqual(expected);
    },
  );

  it("does not auto-enable a community plugin claiming core type", () => {
    expect(
      resolvePluginSelection({
        activePluginIds: [],
        requestedPluginIds: [],
        plugins: [
          plugin("community-core", {
            pluginType: "core-plugin",
            source: "community",
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("keeps a resolved replacement and its dependencies unchanged on repeated resolution", () => {
    const plugins = [
      plugin("core", {
        pluginType: "core-plugin",
        relations: {
          provides: ["narrative-engine"],
          conflicts: ["replacement"],
        },
      }),
      plugin("replacement", {
        relations: {
          provides: ["narrative-engine"],
          conflicts: ["core"],
          requires: ["memory/read"],
        },
      }),
      plugin("memory", { relations: { requires: ["replacement/narrate"] } }),
    ];
    const resolved = resolvePluginSelection({
      activePluginIds: ["replacement"],
      requestedPluginIds: ["replacement"],
      plugins,
    });
    expect(resolved).toEqual(["replacement", "memory"]);

    expect(
      resolvePluginSelection({
        activePluginIds: resolved,
        requestedPluginIds: resolved,
        plugins,
      }),
    ).toEqual(resolved);
  });
});
