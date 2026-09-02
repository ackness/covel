import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsStoreApi } from "@covel/settings";
import i18n from "@/i18n";
import { SettingsDialog } from "../SettingsDialog.js";

const settingsMocks = vi.hoisted(() => ({
  store: {
    listEntries: () => [],
    subscribeAll: () => () => undefined,
  } as unknown as SettingsStoreApi,
}));

vi.mock("../use-settings.js", () => ({
  useSettingsStore: () => settingsMocks.store,
}));

vi.mock("@/lib/desktop-bridge.js", () => ({
  isDesktopApp: () => false,
}));

vi.mock("../DataPane.js", () => ({ DataPane: () => <div>Data pane</div> }));
vi.mock("../DesktopPane.js", () => ({
  DesktopPane: () => <div>Desktop pane</div>,
}));
vi.mock("../panes/AppearancePane.js", () => ({
  AppearancePane: () => <div>Appearance pane</div>,
}));
vi.mock("../panes/LlmAdvancedPane.js", () => ({
  LlmAdvancedPane: () => <div>Advanced pane</div>,
}));
vi.mock("../panes/LlmPresetsPane.js", () => ({
  LlmPresetsPane: () => <div>Presets pane</div>,
}));
vi.mock("../panes/LlmSlotsPane.js", () => ({
  LlmSlotsPane: () => <div>Slots pane</div>,
}));
vi.mock("../panes/OperatorAccessPane.js", () => ({
  OperatorAccessPane: () => <div>Operator pane</div>,
}));
vi.mock("../panes/PackagesPane.js", () => ({
  PackagesPane: () => <div>Packages pane</div>,
}));

describe("SettingsDialog navigation", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  afterEach(() => cleanup());

  it("uses a compact mobile section picker and full-width content", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    const sidebar = screen.getByRole("complementary");
    const sectionPicker = screen.getByRole("combobox", { name: "Settings" });
    const desktopNav = screen.getByRole("navigation", { name: "Settings" });
    const content = (await screen.findByText("Appearance pane")).closest(
      "section",
    );

    expect(sidebar.className).toContain("w-full");
    expect(sidebar.className).toContain("sm:w-56");
    expect(sectionPicker.parentElement?.className).toContain("sm:hidden");
    expect(desktopNav.className).toContain("hidden");
    expect(desktopNav.className).toContain("sm:block");
    expect(content?.className).toContain("p-4");
    expect(content?.className).toContain("sm:p-6");
  });

  it("renders group labels as headings and marks the selected page", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "LLM" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "LLM" })).toBeNull();

    const modelRoles = screen.getByRole("button", { name: "Model Roles" });
    fireEvent.click(modelRoles);

    await waitFor(() =>
      expect(modelRoles.getAttribute("aria-current")).toBe("page"),
    );
  });

  it("labels search and clears a stale query after a locale change", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    const search = screen.getByRole("textbox", { name: "Search settings..." });
    fireEvent.change(search, { target: { value: "operator" } });
    expect((search as HTMLInputElement).value).toBe("operator");

    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });

    const localizedSearch = screen.getByRole("textbox", {
      name: "搜索设置...",
    });
    await waitFor(() =>
      expect((localizedSearch as HTMLInputElement).value).toBe(""),
    );
  });
});
