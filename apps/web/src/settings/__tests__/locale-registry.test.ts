import { describe, expect, it, vi } from "vitest";
import type { SettingEntry, SettingsStoreApi } from "@covel/settings";
import { supportedLocales } from "@/i18n/catalog-registry.js";
import { registerCoreSettings } from "../registry/core.js";

describe("locale setting registry", () => {
  it("derives validation and select options from the shared registry", () => {
    const entries: SettingEntry[] = [];
    const store = {
      register: vi.fn((entry: SettingEntry) => entries.push(entry)),
    } as unknown as SettingsStoreApi;

    registerCoreSettings(store);
    const locale = entries.find((entry) => entry.key === "ui.locale");

    expect(locale?.options?.map((option) => option.value)).toEqual(
      supportedLocales,
    );
    expect(locale?.schema.safeParse("ru-RU").success).toBe(true);
    expect(locale?.schema.safeParse("fr-FR").success).toBe(false);
    expect(locale?.schema.safeParse("ru_ru").success).toBe(false);
    expect(locale?.schema.safeParse("RU-ru").success).toBe(false);
  });
});
