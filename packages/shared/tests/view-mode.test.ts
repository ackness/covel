import { describe, expect, it } from "vitest";
import {
  parsePluginViewMode,
  pluginViewMode,
  viewModeSchema,
} from "../src/schemas/view-mode.js";
import { pluginIdSchema } from "../src/schemas/plugin-manifest.js";
import { pluginPackSchema } from "../src/schemas/api-contract.js";
import { validateWorldManifest } from "../src/index.js";

describe("view modes", () => {
  it("parses and round trips a plugin view", () => {
    expect(
      parsePluginViewMode(pluginViewMode("my-plug", "dm-console")),
    ).toEqual({ pluginId: "my-plug", viewId: "dm-console" });
  });
  it.each([
    "plugin:a",
    "plugin:a:b:c",
    "plugin:A:b",
    "plugin:a:1b",
    "plugin::b",
    `plugin:a:${"a".repeat(65)}`,
  ])("rejects %s", (mode) => {
    expect(parsePluginViewMode(mode)).toBeUndefined();
  });
  it("keeps the plugin pattern aligned without importing a cyclic manifest", () => {
    for (const id of [
      "a",
      "my-plug",
      "a1",
      "a--",
      "1a",
      "A",
      "a_b",
      "",
      "a:b",
      "a.b",
      "ä",
    ]) {
      expect(Boolean(parsePluginViewMode(`plugin:${id}:v`))).toBe(
        pluginIdSchema.safeParse(id).success,
      );
    }
    expect(() => pluginViewMode("bad:id", "view")).toThrow();
  });
  it.each(["stage", "parsed", "plugin:x:y"])("accepts default %s", (mode) => {
    expect(viewModeSchema.safeParse(mode).success).toBe(true);
  });
  it.each(["detailed", "raw", "plugin:"])("rejects default %s", (mode) => {
    expect(viewModeSchema.safeParse(mode).success).toBe(false);
  });
  it("accepts plugin defaults in world and pack declarations", () => {
    expect(
      validateWorldManifest({
        id: "probe",
        name: "Probe",
        summary: "Probe",
        defaultLocale: "en-US",
        defaultViewMode: "plugin:x:y",
      }).valid,
    ).toBe(true);
    expect(
      pluginPackSchema.safeParse({
        id: "probe",
        label: "Probe",
        requested: [],
        recommended: [],
        tags: [],
        source: "builtin",
        defaultViewMode: "plugin:x:y",
      }).success,
    ).toBe(true);
  });
});
