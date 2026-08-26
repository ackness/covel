import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/services/api.js";
import type { WorldRecord } from "@/services/api.js";
import { WorldSelectScreen } from "../world-select-screen.js";

const BUILT_IN_WORLD = {
  id: "built-in",
  name: "内置世界",
  description: "Repository managed",
  metadata: { source: "file" },
} as WorldRecord;

const CUSTOM_WORLD = {
  id: "custom",
  name: "自定义世界",
  description: "Player created",
  metadata: { source: "server-store" },
} as WorldRecord;

function renderScreen(onWorldDeleted = vi.fn()) {
  render(
    <WorldSelectScreen
      worlds={[BUILT_IN_WORLD, CUSTOM_WORLD]}
      packages={[]}
      resolvedSlots={[]}
      settingsOpen={false}
      onSettingsOpenChange={() => {}}
      onSelectWorld={() => {}}
      onWorldDeleted={onWorldDeleted}
    />,
  );
  return onWorldDeleted;
}

describe("world select — deleting player-created worlds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an explicit delete action only for a custom world", () => {
    renderScreen();

    const deleteButtons = screen.getAllByRole("button", {
      name: "删除世界",
    });
    expect(deleteButtons).toHaveLength(1);
    expect(deleteButtons[0]?.textContent).toContain("删除世界");
  });

  it("deletes a custom world after confirmation", async () => {
    const deleteWorld = vi.spyOn(api, "deleteWorld").mockResolvedValue();
    const onWorldDeleted = renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "删除世界" }));
    expect(screen.getByText("删除世界？")).toBeTruthy();
    expect(screen.getByText(/关联的所有会话数据/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(deleteWorld).toHaveBeenCalledWith("custom");
      expect(onWorldDeleted).toHaveBeenCalledWith("custom");
    });
  });

  it("offers the same delete action from custom-world details", () => {
    renderScreen();

    const detailButtons = screen.getAllByRole("button", { name: "查看详情" });
    fireEvent.click(detailButtons[1]!);

    expect(screen.getByRole("button", { name: "删除世界" })).toBeTruthy();
  });
});
