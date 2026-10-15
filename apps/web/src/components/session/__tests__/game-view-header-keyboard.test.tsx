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
import { GameViewHeader } from "../game-view/game-view-header.js";
import { ChapterBanner } from "../chapter-banner.js";
import { SessionCanvasHero } from "../chat-messages/session-canvas-hero.js";
import type { WorldRecord } from "@/services/api.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/debug">{children}</a>
  ),
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

it("uses native buttons in the overflow disclosure and restores focus on Escape and selection", () => {
  const changeView = vi.fn();
  render(
    <GameViewHeader
      t={i18n.t}
      sessionId="s"
      sessionPhase="playing"
      locale="zh-CN"
      turnCount={1}
      world={null}
      executing={false}
      viewMode="parsed"
      isLeftCollapsed
      isRightCollapsed
      onViewModeChange={changeView}
      onToggleLeftPanel={vi.fn()}
      onToggleRightPanel={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenSuspensions={vi.fn()}
      suspensionsCount={0}
      onBackToWorldSelect={vi.fn()}
      onResetSession={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: i18n.t("session.moreActions"),
  });
  fireEvent.click(trigger);
  const group = screen.getByRole("group", {
    name: i18n.t("session.moreActions"),
  });
  const detailed = within(group).getByRole("button", {
    name: i18n.t("session.viewDetailedAria"),
  });
  expect(detailed.getAttribute("aria-pressed")).toBe("false");
  detailed.focus();
  fireEvent.keyDown(detailed, { key: "Escape" });
  expect(
    screen.queryByRole("group", { name: i18n.t("session.moreActions") }),
  ).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.viewDetailedAria") }),
  );
  expect(changeView).toHaveBeenCalledWith("detailed");
  expect(document.activeElement).toBe(trigger);
});

const world: WorldRecord = {
  id: "translated-world",
  name: "English world",
  description: "An English summary.",
  locale: "en-US",
  createdAt: "2026-10-15",
  metadata: {
    localizedText: {
      name: { "zh-CN": "中文世界" },
      description: { "zh-CN": "中文世界简介。" },
    },
  },
};

it.each(["zh-CN", "en-US"])(
  "shows the session edition in the header, banner and hero with %s UI labels",
  async (interfaceLocale) => {
    await i18n.changeLanguage(interfaceLocale);
    const session = { locale: "zh-CN" };
    render(
      <>
        <GameViewHeader
          t={i18n.t}
          sessionId="translated-session"
          sessionPhase="playing"
          locale={session.locale}
          turnCount={1}
          world={world}
          executing={false}
          viewMode="parsed"
          isLeftCollapsed
          isRightCollapsed
          onViewModeChange={vi.fn()}
          onToggleLeftPanel={vi.fn()}
          onToggleRightPanel={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenSuspensions={vi.fn()}
          suspensionsCount={0}
          onBackToWorldSelect={vi.fn()}
          onResetSession={vi.fn()}
        />
        <ChapterBanner world={world} locale={session.locale} />
        <SessionCanvasHero
          world={world}
          locale={session.locale}
          onBegin={vi.fn()}
          beginLabel="Begin"
          hintLabel="Welcome"
        />
      </>,
    );
    expect(screen.getAllByText("中文世界")).toHaveLength(3);
    expect(screen.getByText("中文世界简介。")).toBeTruthy();
    expect(screen.queryByText("English world")).toBeNull();
    expect(screen.queryByText("An English summary.")).toBeNull();
  },
);
