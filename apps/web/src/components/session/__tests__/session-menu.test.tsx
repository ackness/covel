import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { SessionMenu } from "../game-view/session-menu.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/debug">{children}</a>
  ),
}));
vi.mock("../session-music.js", () => ({
  MusicMenuControls: () => <div>music controls</div>,
}));
afterEach(cleanup);

function setup(developerMode: boolean, themeSection: ReactNode = null) {
  const calls = {
    onViewModeChange: vi.fn(),
    onOpenGameSettings: vi.fn(),
    onOpenSettings: vi.fn(),
    onRestart: vi.fn(),
    onExport: vi.fn(),
    onOpenDatabase: vi.fn(),
  };
  render(
    <SessionMenu
      t={i18n.t}
      sessionId="s"
      executing={false}
      developerMode={developerMode}
      viewMode="parsed"
      themeSection={themeSection}
      {...calls}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Menu" });
  fireEvent.click(trigger);
  return {
    calls,
    trigger,
    menu: screen.getByRole("group", { name: "Menu" }),
  };
}

it("lists this game, preferences and no developer section by default", async () => {
  await i18n.changeLanguage("en-US");
  const { menu } = setup(false, <p>theme section</p>);
  for (const name of [
    "This game's settings…",
    "Start over",
    "Export save",
    "Settings…",
  ])
    expect(within(menu).getByRole("button", { name })).toBeTruthy();
  expect(within(menu).getByText("This game")).toBeTruthy();
  expect(within(menu).getByText("Preferences")).toBeTruthy();
  expect(within(menu).getByText("music controls")).toBeTruthy();
  expect(within(menu).getByText("theme section")).toBeTruthy();
  expect(within(menu).queryByText("Developer")).toBeNull();
  expect(
    within(menu).queryByRole("button", { name: "Detailed view" }),
  ).toBeNull();
  expect(within(menu).queryByRole("button", { name: "Database" })).toBeNull();
});

it("adds the author tools in developer mode", async () => {
  await i18n.changeLanguage("en-US");
  const { menu, calls } = setup(true);
  expect(within(menu).getByText("Developer")).toBeTruthy();
  expect(within(menu).getByText("Debug Traces")).toBeTruthy();
  fireEvent.click(within(menu).getByRole("button", { name: "Raw view" }));
  expect(calls.onViewModeChange).toHaveBeenCalledWith("raw");
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  fireEvent.click(screen.getByRole("button", { name: "Database" }));
  expect(calls.onOpenDatabase).toHaveBeenCalledTimes(1);
});

it("runs each action and closes; Escape returns focus to the trigger", async () => {
  await i18n.changeLanguage("en-US");
  const { menu, calls, trigger } = setup(false);
  fireEvent.click(within(menu).getByRole("button", { name: "Start over" }));
  expect(calls.onRestart).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("group", { name: "Menu" })).toBeNull();
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "Export save" }));
  expect(calls.onExport).toHaveBeenCalledTimes(1);

  fireEvent.click(trigger);
  fireEvent.click(
    screen.getByRole("button", { name: "This game's settings…" }),
  );
  expect(calls.onOpenGameSettings).toHaveBeenCalledTimes(1);

  fireEvent.click(trigger);
  const settings = screen.getByRole("button", { name: "Settings…" });
  settings.focus();
  fireEvent.keyDown(settings, { key: "Escape" });
  expect(screen.queryByRole("group", { name: "Menu" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(calls.onOpenSettings).not.toHaveBeenCalled();
});
