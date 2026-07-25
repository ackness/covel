import { describe, expect, it } from "vitest";
import type { ParsedPluginMd } from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { buildPluginToolAccess } from "../../src/routes/api/bootstrap/plugin-tool-access.js";

function parsedManifest(
  patch: Partial<RuntimeManifest> & Pick<RuntimeManifest, "name">,
): ParsedPluginMd {
  return {
    manifest: {
      pluginId: patch.name.split("/")[0] ?? patch.name,
      description: "test runtime",
      ...patch,
    } as RuntimeManifest,
    promptTemplate: "",
    rawFrontmatter: {},
  };
}

describe("buildPluginToolAccess", () => {
  it("seeds from builtin names only — a `tools.plugin` declaration grants nothing until registration succeeds", () => {
    // Granting from the declaration alone would let a plugin reach another
    // plugin's same-named tool through the global toolMap; `registerTool`
    // grants the name only when its own registration wins.
    const access = buildPluginToolAccess(
      new Map([
        [
          "plugin-a",
          [
            parsedManifest({
              name: "plugin-a/main",
              tools: {
                builtin: ["plugin-data-get"],
                plugin: ["entry-declared-tool"],
              },
            }),
          ],
        ],
      ]),
    );

    expect([...(access.get("plugin-a") ?? [])].sort()).toEqual([
      "plugin-data-get",
    ]);
  });

  it("unions builtin declarations across a plugin's runtimes", () => {
    const access = buildPluginToolAccess(
      new Map([
        [
          "multi",
          [
            parsedManifest({
              name: "multi/one",
              tools: { builtin: ["plugin-data-get"] },
            }),
            parsedManifest({
              name: "multi/two",
              tools: { builtin: ["plugin-data-set", "plugin-data-get"] },
            }),
          ],
        ],
      ]),
    );

    expect([...(access.get("multi") ?? [])].sort()).toEqual([
      "plugin-data-get",
      "plugin-data-set",
    ]);
  });

  it("gives a plugin with no tool declarations an empty allowlist, not a missing entry", () => {
    const access = buildPluginToolAccess(
      new Map([["bare", [parsedManifest({ name: "bare/main" })]]]),
    );
    expect(access.get("bare")).toEqual(new Set());
  });
});
