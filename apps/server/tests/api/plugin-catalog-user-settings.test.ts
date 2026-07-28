import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginUserSettingSpec, RuntimeManifest } from "@covel/shared";
import { mergeUserSettings } from "../../src/routes/misc-api/plugin-catalog.js";

function runtime(
  name: string,
  userSettings: readonly PluginUserSettingSpec[],
): { manifest: RuntimeManifest } {
  return {
    manifest: {
      name,
      pluginId: name.split("/")[0],
      description: "",
      userSettings,
    } as RuntimeManifest,
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

describe("mergeUserSettings", () => {
  it("dedupes an identical key declared by two runtimes without warning", () => {
    // Arrange — the same knob repeated on every runtime that reads it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manifests = [
      runtime("tts/auto", [VOICE]),
      runtime("tts/manual", [{ ...VOICE }]),
    ];

    // Act
    const merged = mergeUserSettings("tts", manifests);

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

    const merged = mergeUserSettings("tts", [
      runtime("tts/auto", [VOICE]),
      runtime("tts/manual", [reordered]),
    ]);

    expect(merged).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and keeps the first when two runtimes declare the key differently", () => {
    // Arrange — diverging defaults for one stored value is an authoring bug.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manifests = [
      runtime("tts/auto", [VOICE]),
      runtime("tts/manual", [{ ...VOICE, default: "other_voice" }]),
    ];

    // Act
    const merged = mergeUserSettings("tts", manifests);

    // Assert
    expect(merged).toHaveLength(1);
    expect(merged[0].default).toBe("mimo_default");
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("plugin.tts.voice");
    expect(message).toContain("tts/auto");
    expect(message).toContain("tts/manual");
  });

  it("keeps distinct keys from different runtimes", () => {
    const merged = mergeUserSettings("img", [
      runtime("img/prompt", [{ ...VOICE, key: "composition" }]),
      runtime("img/generate", [{ ...VOICE, key: "imageSize" }]),
    ]);

    expect(merged.map((s) => s.key)).toEqual(["composition", "imageSize"]);
  });

  it("returns an empty list when no runtime declares settings", () => {
    expect(mergeUserSettings("plain", [runtime("plain", [])])).toEqual([]);
  });
});
