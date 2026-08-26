import { describe, expect, it } from "vitest";
import {
  decodePluginUserSettingsHeader,
  mergePluginUserSettings,
  readWorldPluginSettings,
} from "../../src/routes/api/plugin-user-settings.js";

function header(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("decodePluginUserSettingsHeader", () => {
  it("keeps missing and malformed headers compatible as no settings", () => {
    expect(decodePluginUserSettingsHeader(undefined)).toEqual({
      ok: true,
      settings: undefined,
    });
    expect(decodePluginUserSettingsHeader("not@@base64")).toEqual({
      ok: true,
      settings: undefined,
    });
  });

  it("rejects every declared transport quota with the stable 431 code", () => {
    const oversizedHeader = "a".repeat(8 * 1024 + 1);
    const tooManyBuckets = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`plugin-${index}`, {}]),
    );
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`key-${index}`, index]),
    );
    const cases = [
      oversizedHeader,
      header(tooManyBuckets),
      header({ plugin: tooManyKeys }),
      header({ ["p".repeat(129)]: {} }),
      header({ plugin: { ["k".repeat(129)]: true } }),
    ];

    for (const raw of cases) {
      expect(decodePluginUserSettingsHeader(raw)).toMatchObject({
        ok: false,
        status: 431,
        code: "plugin_user_settings_header_too_large",
      });
    }
  });
});

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
