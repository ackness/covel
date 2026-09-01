import { afterEach, describe, expect, it } from "vitest";
import type { SettingsStoreApi } from "@covel/settings";
import i18n from "@/i18n";
import {
  buildNavTree,
  filterNav,
  OPERATOR_ACCESS_NODE_ID,
} from "../navigation.js";

const emptyStore = {
  listEntries: () => [],
} as unknown as SettingsStoreApi;

describe("operator access settings navigation", () => {
  afterEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("exposes the browser credential pane in every locale", () => {
    const english = buildNavTree(emptyStore, { locale: "en-US" });
    const chinese = buildNavTree(emptyStore, { locale: "zh-CN" });

    expect(
      english.find((node) => node.id === OPERATOR_ACCESS_NODE_ID)?.label,
    ).toBe("Operator Access");
    expect(
      chinese.find((node) => node.id === OPERATOR_ACCESS_NODE_ID)?.label,
    ).toBe("运维访问");
  });

  it("is discoverable through settings search", () => {
    const nodes = buildNavTree(emptyStore, { locale: "en-US" });

    expect(filterNav(nodes, "operator", "en-US")).toEqual([
      expect.objectContaining({ id: OPERATOR_ACCESS_NODE_ID }),
    ]);
  });

  it("derives fixed navigation labels from the selected catalog", async () => {
    await i18n.changeLanguage("ru-RU");
    const nodes = buildNavTree(emptyStore, { locale: "ru-RU" });

    expect(nodes.find((node) => node.id === "appearance")?.label).toBe(
      "Оформление",
    );
    expect(
      nodes.find((node) => node.id === OPERATOR_ACCESS_NODE_ID)?.label,
    ).toBe("Доступ оператора");
    expect(nodes.find((node) => node.id === "packages")?.label).toBe(
      "Импорт пакетов",
    );
  });

  it("uses localized plugin names while keeping plugin ids stable", () => {
    const pluginStore = {
      listEntries: () => [
        {
          key: "plugin.chat-mode-narrator.enabled",
          group: "plugin",
          pluginId: "chat-mode-narrator",
        },
      ],
    } as unknown as SettingsStoreApi;

    const english = buildNavTree(pluginStore, {
      locale: "en-US",
      pluginDisplayNames: {
        "chat-mode-narrator": {
          zh: "对话叙事",
          en: "Dialogue Narrator",
        },
      },
    });

    expect(
      english.find((node) => node.id === "plugin.chat-mode-narrator"),
    ).toEqual(expect.objectContaining({ label: "Dialogue Narrator" }));
  });
});
