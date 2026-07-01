import { describe, expect, it } from "vitest";
import {
  mergePluginUserSettings,
  readWorldPluginSettings,
} from "../../src/routes/api/plugin-user-settings.js";

describe("mergePluginUserSettings", () => {
  it("returns undefined when both layers are empty", () => {
    expect(mergePluginUserSettings(undefined, undefined)).toBeUndefined();
  });

  it("player override wins over world default per key", () => {
    const merged = mergePluginUserSettings(
      { "cost-gate": { softTokens: 100, hardTokens: 200 } },
      { "cost-gate": { softTokens: 50 } },
    );
    expect(merged).toEqual({
      "cost-gate": { softTokens: 50, hardTokens: 200 },
    });
  });

  it("world default fills keys the player did not set", () => {
    const merged = mergePluginUserSettings(
      { narrator: { verbosity: "high" } },
      undefined,
    );
    expect(merged).toEqual({ narrator: { verbosity: "high" } });
  });

  it("merges disjoint plugins from both layers", () => {
    const merged = mergePluginUserSettings({ a: { x: 1 } }, { b: { y: 2 } });
    expect(merged).toEqual({ a: { x: 1 }, b: { y: 2 } });
  });

  it("player-only with no world defaults passes through", () => {
    const merged = mergePluginUserSettings(undefined, { a: { x: 1 } });
    expect(merged).toEqual({ a: { x: 1 } });
  });
});

describe("readWorldPluginSettings", () => {
  it("returns undefined for missing / empty metadata", () => {
    expect(readWorldPluginSettings(undefined)).toBeUndefined();
    expect(readWorldPluginSettings(null)).toBeUndefined();
    expect(readWorldPluginSettings({})).toBeUndefined();
  });

  it("extracts well-formed pluginSettings", () => {
    expect(
      readWorldPluginSettings({ pluginSettings: { a: { x: 1 } } }),
    ).toEqual({ a: { x: 1 } });
  });

  it("drops malformed plugin buckets defensively", () => {
    expect(
      readWorldPluginSettings({
        pluginSettings: { good: { x: 1 }, bad: "nope", arr: [1, 2] },
      }),
    ).toEqual({ good: { x: 1 } });
  });

  it("returns undefined when pluginSettings is not a plain object", () => {
    expect(readWorldPluginSettings({ pluginSettings: "x" })).toBeUndefined();
    expect(readWorldPluginSettings({ pluginSettings: [1] })).toBeUndefined();
  });
});
