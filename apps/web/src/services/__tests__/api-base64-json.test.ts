/**
 * Regression test: AI request headers are base64 of UTF-8 bytes, not `btoa`
 * of a JS string. The app's default locale is zh-CN, so a Chinese custom-preset
 * name or plugin setting is an ordinary input — `btoa` throws on it and used to
 * take down every AI request with a misleading transport error.
 */
import { describe, expect, it } from "vitest";
import {
  encodeBase64Json,
  encodePluginUserSettingsHeader,
  PluginUserSettingsHeaderTooLargeError,
} from "../api/model-settings.js";
import { PLUGIN_USER_SETTINGS_HEADER_MAX_BYTES } from "@covel/shared/plugin-user-settings-header";

/** Mirror of the server's decode (`apps/server/src/lib/base64-json.ts`). */
function decodeAsServerWould(header: string): unknown {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

describe("encodeBase64Json", () => {
  it("round-trips CJK text through the server's UTF-8 decode", () => {
    const value = { customPresets: [{ id: "custom_1", name: "我的预设" }] };

    const decoded = decodeAsServerWould(encodeBase64Json(value));

    expect(decoded).toEqual(value);
  });

  it("round-trips emoji and accented latin", () => {
    const value = { plugin: { note: "café ☕ — naïve 🎲" } };

    expect(decodeAsServerWould(encodeBase64Json(value))).toEqual(value);
  });

  it("does not throw on payloads larger than the chunk size", () => {
    const value = { blob: "长".repeat(50_000) };

    expect(decodeAsServerWould(encodeBase64Json(value))).toEqual(value);
  });

  it("still matches plain btoa for ascii-only payloads", () => {
    const value = { slotPresetOverrides: { default: "custom_1" } };

    expect(encodeBase64Json(value)).toBe(btoa(JSON.stringify(value)));
  });
});

describe("encodePluginUserSettingsHeader", () => {
  it("accepts the encoded 8 KiB boundary and rejects the next payload", () => {
    let length = 0;
    while (
      new TextEncoder().encode(
        encodeBase64Json({ plugin: { value: "x".repeat(length) } }),
      ).byteLength <= PLUGIN_USER_SETTINGS_HEADER_MAX_BYTES
    ) {
      length++;
    }

    expect(() =>
      encodePluginUserSettingsHeader({
        plugin: { value: "x".repeat(length - 1) },
      }),
    ).not.toThrow();
    expect(() =>
      encodePluginUserSettingsHeader({ plugin: { value: "x".repeat(length) } }),
    ).toThrow(PluginUserSettingsHeaderTooLargeError);
    expect(() =>
      encodePluginUserSettingsHeader({ plugin: { value: "x".repeat(length) } }),
    ).toThrow(/plugin_user_settings_header_too_large|8 KiB/);
  });
});
