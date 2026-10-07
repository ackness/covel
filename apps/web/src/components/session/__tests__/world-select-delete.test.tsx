import { getSettings, initSettings } from "@/settings/store.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  beforeAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getDataService } from "@/services/data-service.js";
import type { WorldRecord } from "@/services/api.js";
import { ConfirmHost } from "@/components/ui/confirm-host.js";
import { WorldSelectScreen } from "../world-select-screen.js";

// These assertions exercise the card list, independently of the startup style.
beforeAll(async () => {
  await initSettings();
  await getSettings().set("ui.appearance", "panel");
});

const dataService = vi.hoisted(() => ({ deleteWorld: vi.fn() }));
vi.mock("@/services/data-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/data-service.js")>()),
  getDataService: () => dataService,
}));

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
    <>
      {/* The app shell mounts the host that shows the delete prompt. */}
      <ConfirmHost />
      <WorldSelectScreen
        worlds={[BUILT_IN_WORLD, CUSTOM_WORLD]}
        plugins={[]}
        resolvedSlots={[]}
        settingsOpen={false}
        onSettingsOpenChange={() => {}}
        onSelectWorld={() => {}}
        onWorldDeleted={onWorldDeleted}
      />
    </>,
  );
  return onWorldDeleted;
}

describe("world select — deleting player-created worlds", () => {
  beforeEach(() => vi.clearAllMocks());
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
    const deleteWorld = vi
      .spyOn(getDataService(), "deleteWorld")
      .mockResolvedValue();
    const onWorldDeleted = renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "删除世界" }));
    expect(await screen.findByText("删除世界？")).toBeTruthy();
    // The prompt names the world, so the player can check what goes.
    expect(
      screen.getByText(/「自定义世界」及其关联的所有会话数据/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(deleteWorld).toHaveBeenCalledWith("custom");
      expect(onWorldDeleted).toHaveBeenCalledWith("custom");
    });
  });

  it("confirms world deletion with Enter while no button has the focus", async () => {
    const deleteWorld = vi
      .spyOn(getDataService(), "deleteWorld")
      .mockResolvedValue();
    const onWorldDeleted = renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "删除世界" }));
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Enter" });

    await waitFor(() => {
      expect(deleteWorld).toHaveBeenCalledTimes(1);
      expect(deleteWorld).toHaveBeenCalledWith("custom");
      expect(onWorldDeleted).toHaveBeenCalledWith("custom");
    });
  });

  it("leaves Enter on Cancel to that button instead of deleting", async () => {
    const deleteWorld = vi
      .spyOn(getDataService(), "deleteWorld")
      .mockResolvedValue();
    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "删除世界" }));
    const cancel = await screen.findByRole("button", { name: "取消" });
    cancel.focus();
    // Not prevented: the browser goes on to press the focused button.
    expect(fireEvent.keyDown(cancel, { key: "Enter" })).toBe(true);
    fireEvent.click(cancel);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deleteWorld).not.toHaveBeenCalled();
  });

  it("opens the same delete confirmation from custom-world details", async () => {
    renderScreen();

    const detailButtons = screen.getAllByRole("button", { name: "查看详情" });
    fireEvent.click(detailButtons[1]!);

    fireEvent.click(screen.getByRole("button", { name: "删除世界" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("删除世界？")).toBeTruthy();
  });
});
