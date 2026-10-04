import { fireEvent, render, screen } from "@testing-library/react";
import { BookOpen, Database, Heart } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { PanelTabMenu } from "../panel-tab-menu.js";

const ITEMS = [
  { value: "world", label: "世界", icon: BookOpen },
  { value: "database", label: "数据库", icon: Database },
  { value: "plugin-affinity", label: "好感", icon: Heart },
];

describe("panel tab menu", () => {
  it("lists every tab and switches to the one picked", () => {
    const onSelect = vi.fn();
    render(
      <PanelTabMenu
        items={ITEMS}
        active="database"
        label="全部面板"
        onSelect={onSelect}
      />,
    );
    expect(screen.queryByRole("menu")).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: "全部面板" }));
    expect(
      screen.getAllByRole("menuitemradio").map((item) => item.textContent),
    ).toEqual(["世界", "数据库", "好感"]);
    expect(
      screen.getByRole("menuitemradio", { checked: true }).textContent,
    ).toBe("数据库");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "好感" }));
    expect(onSelect).toHaveBeenCalledWith("plugin-affinity");
    expect(screen.queryByRole("menu")).toBe(null);
  });

  it("closes on Escape and on a press outside", () => {
    render(
      <PanelTabMenu
        items={ITEMS}
        active="world"
        label="全部面板"
        onSelect={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: "全部面板" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBe(null);

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBe(null);
  });
});
