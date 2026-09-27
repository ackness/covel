import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginUserSettingSpec, RuntimeManifest } from "@covel/shared";
import { mergePluginUserSettings } from "../../src/lib/plugin-descriptor.js";

function runtime(
  name: string,
  userSettings: readonly PluginUserSettingSpec[],
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: "",
    userSettings,
  };
}

const VOICE: PluginUserSettingSpec = {
  key: "voice",
  type: "text",
  default: "mimo_default",
  label: { "zh-CN": "音色", "en-US": "Voice" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mergePluginUserSettings", () => {
  it("dedupes an identical key declared by two runtimes without warning", () => {
    // Arrange — the same knob repeated on every runtime that reads it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manifests = [
      runtime("tts/auto", [VOICE]),
      runtime("tts/manual", [{ ...VOICE }]),
    ];

    // Act
    const merged = mergePluginUserSettings("tts", manifests);

    // Assert
    expect(merged).toHaveLength(1);
    expect(merged[0].key).toBe("voice");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats field ordering as identical, not as a divergence", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reordered: PluginUserSettingSpec = {
      label: { "en-US": "Voice", "zh-CN": "音色" },
      default: "mimo_default",
      type: "text",
      key: "voice",
    };

    const merged = mergePluginUserSettings("tts", [
      runtime("tts/auto", [VOICE]),
      runtime("tts/manual", [reordered]),
    ]);

    expect(merged).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects different defaults for one plugin setting", () => {
    expect(() =>
      mergePluginUserSettings("tts", [
        runtime("tts/auto", [VOICE]),
        runtime("tts/manual", [{ ...VOICE, default: "other_voice" }]),
      ]),
    ).toThrow(/Conflicting userSettings.*tts\/auto.*tts\/manual/);
  });

  it("keeps distinct keys from different runtimes", () => {
    const merged = mergePluginUserSettings("img", [
      runtime("img/prompt", [{ ...VOICE, key: "composition" }]),
      runtime("img/generate", [{ ...VOICE, key: "imageSize" }]),
    ]);

    expect(merged.map((s) => s.key)).toEqual(["composition", "imageSize"]);
  });

  it("returns an empty list when no runtime declares settings", () => {
    expect(mergePluginUserSettings("plain", [runtime("plain", [])])).toEqual(
      [],
    );
  });
});
