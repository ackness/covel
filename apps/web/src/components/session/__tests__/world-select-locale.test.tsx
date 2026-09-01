import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { WorldRecord } from "@/services/api.js";
import { WorldSelectScreen } from "../world-select-screen.js";

const ENGLISH_WORLD = {
  id: "english-world",
  name: "English World",
  description: "English-first content",
  locale: "en-US",
  metadata: { source: "file" },
} as WorldRecord;

const CHINESE_WORLD_ONE = {
  id: "chinese-world-one",
  name: "中文世界一",
  description: "中文优先内容",
  locale: "zh-CN",
  metadata: { source: "file" },
} as WorldRecord;

const CHINESE_WORLD_TWO = {
  id: "chinese-world-two",
  name: "中文世界二",
  description: "中文优先内容",
  locale: "zh-Hans",
  metadata: { source: "file" },
} as WorldRecord;

function worldTitles(): string[] {
  return screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent ?? "");
}

describe("world select — locale preference", () => {
  afterEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("reprioritizes worlds when the interface language changes", async () => {
    await i18n.changeLanguage("zh-CN");
    render(
      <WorldSelectScreen
        worlds={[ENGLISH_WORLD, CHINESE_WORLD_ONE, CHINESE_WORLD_TWO]}
        packages={[]}
        resolvedSlots={[]}
        settingsOpen={false}
        onSettingsOpenChange={() => {}}
        onSelectWorld={() => {}}
      />,
    );

    expect(worldTitles()).toEqual([
      "中文世界一",
      "中文世界二",
      "English World",
    ]);
    expect(screen.getByTitle("世界语言：英语").textContent).toBe("EN");
    expect(screen.getAllByTitle("世界语言：简体中文")).toHaveLength(2);

    await act(async () => {
      await i18n.changeLanguage("en-US");
    });

    await waitFor(() => {
      expect(worldTitles()).toEqual([
        "English World",
        "中文世界一",
        "中文世界二",
      ]);
    });
    expect(screen.getByTitle("World language: English").textContent).toBe("EN");
    expect(
      screen.getAllByTitle("World language: Chinese (Simplified)"),
    ).toHaveLength(2);
  });

  it("asks for confirmation before entering a mismatched world", async () => {
    await i18n.changeLanguage("zh-CN");
    const onSelectWorld = vi.fn();
    render(
      <WorldSelectScreen
        worlds={[ENGLISH_WORLD]}
        packages={[]}
        resolvedSlots={[]}
        settingsOpen={false}
        onSettingsOpenChange={() => {}}
        onSelectWorld={onSelectWorld}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    expect(onSelectWorld).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", {
        name: "要进入英语世界吗？",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/以英语内容为主/)).toBeTruthy();
    expect(screen.getByText("当前界面")).toBeTruthy();
    expect(screen.getByText("世界内容")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "以英语继续" }));
    expect(onSelectWorld).toHaveBeenCalledWith("english-world");
  });
});
