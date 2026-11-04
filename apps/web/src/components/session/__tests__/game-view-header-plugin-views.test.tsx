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
vi.mock("../session-music.js", () => ({ MusicMenuControls: () => null }));
afterEach(cleanup);
const props = (): ComponentProps<typeof GameViewHeader> => ({
  menu: null,
  t: i18n.t,
  sessionId: "s",
  sessionPhase: "playing",
  locale: "en-US",
  turnCount: 1,
  world: null,
  executing: false,
  viewMode: "parsed",
  pluginViews: [],
  isRightCollapsed: true,
  onViewModeChange: vi.fn(),
  onToggleRightPanel: vi.fn(),
  onOpenSuspensions: vi.fn(),
  onBackToWorldSelect: vi.fn(),
  suspensionsCount: 0,
});
it("adds no page menu without plugin pages", () => {
  render(<GameViewHeader {...props()} />);
  expect(
    screen.queryByRole("button", { name: i18n.t("session.pluginPages") }),
  ).toBeNull();
});
it("lists labels and plugin names and changes the selected view", () => {
  const values = props();
  render(<GameViewHeader {...values} pluginViews={[viewEntry]} />);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.pluginPages") }),
  );
  expect(screen.getByText("Probe")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Reader/ }));
  expect(values.onViewModeChange).toHaveBeenCalledWith("plugin:p:v");
});
it("shows neither Text nor Stage active on a plugin page and leaves it on click", () => {
  const values = props();
  render(
    <GameViewHeader
      {...values}
      pluginViews={[viewEntry]}
      viewMode={viewEntry.mode}
      executing
    />,
  );
  expect(
    screen.queryByRole("button", { name: i18n.t("session.backToDefaultView") }),
  ).toBeNull();
  const text = screen.getByRole("button", {
    name: i18n.t("session.viewRead"),
  });
  const stage = screen.getByRole("button", {
    name: i18n.t("session.viewStage"),
  });
  expect(text.getAttribute("aria-pressed")).toBe("false");
  expect(stage.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(text);
  expect(values.onViewModeChange).toHaveBeenCalledWith("parsed");
  fireEvent.click(stage);
  expect(values.onViewModeChange).toHaveBeenCalledWith("stage");
});
it("offers Stop beside the busy state only when the page hides the host composer", () => {
  const onStop = vi.fn();
  const values = props();
  const { rerender } = render(
    <GameViewHeader {...values} stoppable onStop={onStop} />,
  );
  const stop = i18n.t("session.stopTurn");
  expect(screen.queryByRole("button", { name: stop })).toBeNull();
  rerender(
    <GameViewHeader {...values} stoppable onStop={onStop} composerHidden />,
  );
  fireEvent.click(screen.getByRole("button", { name: stop }));
  expect(onStop).toHaveBeenCalledOnce();
  rerender(<GameViewHeader {...values} onStop={onStop} composerHidden />);
  expect(screen.queryByRole("button", { name: stop })).toBeNull();
});
