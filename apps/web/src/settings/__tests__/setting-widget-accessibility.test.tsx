import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingEntry, WidgetKind } from "@covel/settings";
import i18n from "@/i18n";
import { SettingWidget } from "../widgets/index.js";

vi.mock("../use-settings.js", () => ({
  useSetting: (_key: string) => ["", vi.fn()],
}));

function entry(
  key: string,
  label: string,
  widget: WidgetKind,
  extra: Partial<SettingEntry> = {},
): SettingEntry {
  return {
    key,
    label,
    widget,
    group: "general",
    default: "",
    ...extra,
  } as unknown as SettingEntry;
}

describe("SettingWidget accessible labels", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  afterEach(() => cleanup());

  it("associates labels with text, number, select, textarea, secret and switch controls", () => {
    render(
      <>
        <SettingWidget entry={entry("demo.text", "Text setting", "text")} />
        <SettingWidget
          entry={entry("demo.number", "Number setting", "number")}
        />
        <SettingWidget
          entry={entry("demo.select", "Select setting", "select", {
            options: [{ value: "first", label: "First" }],
          })}
        />
        <SettingWidget
          entry={entry("demo.notes", "Notes setting", "textarea")}
        />
        <SettingWidget
          entry={entry("demo.secret", "Secret setting", "secret")}
        />
        <SettingWidget
          entry={entry("demo.toggle", "Toggle setting", "toggle", {
            default: false,
          })}
        />
      </>,
    );

    expect(screen.getByLabelText("Text setting").id).toBe("setting-demo.text");
    expect(screen.getByLabelText("Number setting").id).toBe(
      "setting-demo.number",
    );
    expect(screen.getByLabelText("Select setting").id).toBe(
      "setting-demo.select",
    );
    expect(screen.getByLabelText("Notes setting").id).toBe(
      "setting-demo.notes",
    );
    expect(screen.getByLabelText("Secret setting").id).toBe(
      "setting-demo.secret",
    );
    expect(screen.getByRole("switch", { name: "Toggle setting" }).id).toBe(
      "setting-demo.toggle",
    );
  });

  it("gives both slider controls the setting label", () => {
    render(
      <SettingWidget
        entry={entry("demo.slider", "Slider setting", "slider", {
          default: 0.5,
          min: 0,
          max: 1,
          step: 0.1,
        })}
      />,
    );

    const controls = screen.getAllByLabelText("Slider setting");
    expect(controls).toHaveLength(2);
    expect(controls.map((control) => control.getAttribute("type"))).toEqual([
      "range",
      "number",
    ]);
    expect(controls.map((control) => control.id)).toEqual([
      "setting-demo.slider",
      "setting-demo.slider-number",
    ]);
  });

  it("uses catalog text for framework settings and preserves plugin I18nText", async () => {
    await i18n.changeLanguage("ru-RU");
    render(
      <>
        <SettingWidget
          entry={entry("ui.appearance", "Appearance", "text", {
            description:
              "Choose the active interface style. Imported custom themes appear here automatically.",
          })}
        />
        <SettingWidget
          entry={entry("ui.scheme", "Color scheme", "select", {
            options: [
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ],
          })}
        />
        <SettingWidget
          entry={entry(
            "ui.chatMessageWindow",
            "Chat window message limit",
            "number",
            { default: 2000 },
          )}
        />
        <SettingWidget
          entry={entry("ui.locale", "Plugin fallback", "text", {
            pluginId: "demo",
            label: {
              "en-US": "Plugin label",
              "ru-RU": "Метка плагина",
            },
          })}
        />
        <SettingWidget
          entry={entry("plugin.mode", "Plugin mode", "select", {
            pluginId: "demo",
            options: [
              {
                value: "story",
                label: {
                  "en-US": "Story",
                  "ru-RU": "История",
                },
              },
            ],
          })}
        />
      </>,
    );

    expect(screen.getByLabelText("Оформление")).toBeTruthy();
    expect(
      screen.getByText(
        "Выберите стиль интерфейса. Импортированные пользовательские темы появятся здесь автоматически.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "Светлая" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Тёмная" })).toBeTruthy();
    expect(
      screen.getByLabelText("Ограничение сообщений в окне чата"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Метка плагина")).toBeTruthy();
    expect(screen.getByRole("option", { name: "История" })).toBeTruthy();
  });
});
