import type { ComponentProps, ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { GameViewHeader } from "../game-view/game-view-header.js";
import { viewEntry } from "./plugin-view-fixtures.js";
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/theme-system/use-theme-layout.js", () => ({
  useThemeLayout: () => ({ backdrop: "plain" }),
}));
vi.mock("@/stores/ui-slot-store.js", () => ({ useUiSlot: () => undefined }));
vi.mock("../game-view/connection-status.js", () => ({
  ConnectionStatus: () => null,
}));
vi.mock("../session-music.js", () => ({ MusicToggle: () => null }));
afterEach(cleanup);
const props = (): ComponentProps<typeof GameViewHeader> => ({
  t: i18n.t,
  sessionId: "s",
  sessionPhase: "playing",
  locale: "en-US",
  turnCount: 1,
  world: null,
  executing: false,
  viewMode: "parsed",
  pluginViews: [],
  hostDefaultMode: "parsed",
  isLeftCollapsed: true,
  isRightCollapsed: true,
  onViewModeChange: vi.fn(),
  onToggleLeftPanel: vi.fn(),
  onToggleRightPanel: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenSuspensions: vi.fn(),
  onBackToWorldSelect: vi.fn(),
  onResetSession: vi.fn(),
  suspensionsCount: 0,
});
it("adds no view menu or back button without plugin views", () => {
  render(<GameViewHeader {...props()} />);
  expect(
    screen.queryByRole("button", { name: i18n.t("session.pluginViews") }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: i18n.t("session.backToDefaultView") }),
  ).toBeNull();
});
it("lists labels and plugin names and changes the selected view", () => {
  const values = props();
  render(<GameViewHeader {...values} pluginViews={[viewEntry]} />);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.pluginViews") }),
  );
  expect(screen.getByText("Probe")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Reader/ }));
  expect(values.onViewModeChange).toHaveBeenCalledWith("plugin:p:v");
});
it("keeps the host back control enabled during execution", () => {
  const values = props();
  render(
    <GameViewHeader
      {...values}
      pluginViews={[viewEntry]}
      viewMode={viewEntry.mode}
      hostDefaultMode="stage"
      executing
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.backToDefaultView") }),
  );
  expect(values.onViewModeChange).toHaveBeenCalledWith("stage");
});
