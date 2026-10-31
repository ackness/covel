import { describe, expect, it } from "vitest";
import {
  resolveWorldPluginSelection,
  validateWorldManifest,
  worldManifestSchema,
  worldPluginReferenceSchema,
  type PluginPack,
} from "../src/index.js";

const pack = (id: string, requested = [id]): PluginPack => ({
  id,
  requested,
  recommended: [],
  tags: [],
  label: id,
  source: "builtin",
});
const catalogue = [pack("same"), pack("second"), pack("third")];
const world = {
  name: "Frontier",
  summary: "Keep the relay alive.",
  defaultLocale: "en-US",
};

describe("world plugin references", () => {
  it("validates all reference kinds and keeps pack and plugin slugs distinct", () => {
    const plugins = ["pack:same", "plugin:same", "contract:action-check@1"];
    expect(worldManifestSchema.parse({ ...world, plugins }).plugins).toEqual(
      plugins,
    );
    const resolved = resolveWorldPluginSelection(plugins, catalogue);
    expect(resolved.selection).toEqual({
      requestedPluginIds: ["same"],
      requiredContracts: ["action-check@1"],
    });
    expect(resolved.requests).toEqual([
      { pluginId: "same", path: "plugins[0]", packId: "same" },
      { pluginId: "same", path: "plugins[1]" },
    ]);
  });
  it.each([
    "bare",
    "unknown:same",
    "contract:check",
    "contract:check@0",
    "contract:check@1.0",
    "plugin:bad/slug",
  ])("rejects %s at the authored field index", (reference) => {
    expect(worldPluginReferenceSchema.safeParse(reference).success).toBe(false);
    const result = worldManifestSchema.safeParse({
      ...world,
      plugins: ["plugin:valid", reference],
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.path).toEqual(["plugins", 1]);
    expect(
      resolveWorldPluginSelection([reference], catalogue).diagnostics,
    ).toEqual([{ code: "invalid-reference", path: "plugins[0]" }]);
  });
  it("rejects redundant duplicates strictly and expands them only once", () => {
    const plugins = ["plugin:same", "plugin:same"];
    expect(validateWorldManifest({ ...world, plugins }).valid).toBe(false);
    const resolved = resolveWorldPluginSelection(plugins, catalogue);
    expect(resolved.selection.requestedPluginIds).toEqual(["same"]);
    expect(resolved.diagnostics).toEqual([
      {
        code: "redundant-reference",
        path: "plugins[1]",
        reference: "plugin:same",
      },
    ]);
  });
  it.each([undefined, []])(
    "selects no initial pack or additions for %s",
    (plugins) => {
      const resolved = resolveWorldPluginSelection(plugins, catalogue);
      expect(resolved.selectedPackId).toBeUndefined();
      expect(resolved.requests).toEqual([]);
      expect(resolved.packs).toEqual(catalogue);
    },
  );
  it("expands the initial pack at its authored position among independent requests", () => {
    const resolved = resolveWorldPluginSelection(
      ["plugin:before", "pack:same", "plugin:after"],
      catalogue,
    );
    expect(resolved.requests.map((ref) => ref.pluginId)).toEqual([
      "before",
      "same",
      "after",
    ]);
  });
  it("uses the first pack, orders alternatives and leaves the rest available", () => {
    const resolved = resolveWorldPluginSelection(
      ["pack:second", "pack:same"],
      catalogue,
    );
    expect(resolved.selectedPackId).toBe("second");
    expect(resolved.packs.map(({ id }) => id)).toEqual([
      "second",
      "same",
      "third",
    ]);
    expect(resolved.requests.map(({ pluginId }) => pluginId)).toEqual([
      "second",
    ]);
  });
  it("does not substitute a later pack for an unavailable first pack", () => {
    const resolved = resolveWorldPluginSelection(
      ["pack:absent", "pack:second"],
      catalogue,
    );
    expect(resolved.selectedPackId).toBeUndefined();
    expect(resolved.requests).toEqual([]);
    expect(resolved.diagnostics).toEqual([
      {
        code: "unknown-pack",
        path: "plugins[0]",
        reference: "pack:absent",
        packId: "absent",
      },
    ]);
  });
  it("rejects removed fields for authors and omits them when loading for play", () => {
    const input = {
      ...world,
      pluginPolicy: { preset: "same" },
    };
    expect(validateWorldManifest(input).valid).toBe(false);
    const loaded = validateWorldManifest(input, {
      ignoreUnknownRootFields: true,
    });
    expect(loaded.valid).toBe(true);
    expect(loaded.ignoredFields).toContain("pluginPolicy");
    expect(loaded.data).toMatchObject(world);
    expect(loaded.data).not.toHaveProperty("pluginPolicy");
  });
  it.each(["preset", "plus", "packs", "requires"])(
    "rejects removed root field %s",
    (field) => {
      expect(validateWorldManifest({ ...world, [field]: [] }).valid).toBe(
        false,
      );
    },
  );
  it("drops only an invalid optional selection while retaining public content", () => {
    const loaded = validateWorldManifest(
      { ...world, plugins: ["bare"], pluginPitch: { label: "Watch" } },
      { ignoreUnknownRootFields: true },
    );
    expect(loaded.valid).toBe(true);
    expect(loaded.data).toMatchObject({
      ...world,
      pluginPitch: { label: "Watch" },
    });
    expect(loaded.data).not.toHaveProperty("plugins");
    expect(loaded.droppedSections?.[0]?.path).toBe("plugins.0");
  });
});
