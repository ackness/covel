import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { GameViewHeader } from "../game-view/game-view-header.js";
import { MessageComposer } from "../game-view/message-composer.js";
import type { ExecutionPresentation } from "../execution-presentation.js";
import { executionRecoveryNoticeVisible } from "../execution-presentation.js";
import { ExecutionRecoveryNotice } from "../execution-recovery-notice.js";
import { NoticeHost } from "@/components/ui/notice-host.js";
import type { ExecutionRecovery } from "@/stores/session-store/types.js";
import { ChapterBanner } from "../chapter-banner.js";
import { SessionCanvasHero } from "../chat-messages/session-canvas-hero.js";
import type { SessionRecord, WorldRecord } from "@/services/api.js";

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
vi.mock("../session-music.js", () => ({ MusicMenuControls: () => null }));
afterEach(cleanup);

function sessionStatus(
  phase: SessionRecord["phase"],
  executionState: ExecutionPresentation,
  executing = false,
  recovery?: ExecutionRecovery,
) {
  return (
    <>
      <GameViewHeader
        menu={null}
        pluginViews={[]}
        recoveryNoticeVisible={executionRecoveryNoticeVisible(recovery)}
        t={i18n.t}
        sessionId="s"
        sessionPhase={phase}
        locale="en-US"
        turnCount={0}
        world={null}
        executing={executing}
        executionState={executionState}
        viewMode="parsed"
        isRightCollapsed
        onViewModeChange={vi.fn()}
        onToggleRightPanel={vi.fn()}
        onOpenSuspensions={vi.fn()}
        suspensionsCount={0}
        onBackToWorldSelect={vi.fn()}
      />
      <MessageComposer
        recoveryNoticeVisible={executionRecoveryNoticeVisible(recovery)}
        t={i18n.t}
        session={{ phase, status: "active" } as SessionRecord}
        executing={executing}
        executionState={executionState}
        inputValue=""
        composerBlocked={false}
        composerDisabled={false}
        awaitingBegin={false}
        onInputValueChange={vi.fn()}
        onSubmit={vi.fn()}
        onKeyDown={vi.fn()}
      />
      <ExecutionRecoveryNotice
        recovery={recovery}
        onRetry={vi.fn()}
        onRefresh={vi.fn()}
        onStop={vi.fn()}
        onOpenSettings={vi.fn()}
      />
      <NoticeHost />
    </>
  );
}

it.each(["failed", "interrupted"] as const)(
  "lets the recovery notice own the playing %s state without header/composer duplicates",
  (state) => {
    const recovery: ExecutionRecovery = {
      sessionId: "s",
      hydrating: false,
      checking: false,
      status: {
        state,
        turnId: "t",
        retry: { type: "retry_turn", payload: {} },
      },
    };
    const view = render(sessionStatus("playing", state, false, recovery));
    expect(screen.getByTestId("notice-execution-recovery")).toBeTruthy();
    expect(
      screen.queryByText(i18n.t(`session.executionState.${state}`)),
    ).toBeNull();
    view.rerender(sessionStatus("playing", state));
    expect(screen.queryByTestId("notice-execution-recovery")).toBeNull();
    expect(
      screen.getAllByText(i18n.t(`session.executionState.${state}`)),
    ).toHaveLength(2);
  },
);

it.each(["generating", "updating"] as const)(
  "keeps %s progress while the recovery notice observes a running turn",
  (state) => {
    render(
      sessionStatus("playing", state, true, {
        sessionId: "s",
        hydrating: false,
        checking: false,
        status: { state: "running", turnId: "t" },
      }),
    );
    expect(screen.getByTestId("notice-execution-recovery")).toBeTruthy();
    expect(
      screen.getAllByText(i18n.t(`session.executionState.${state}`)),
    ).toHaveLength(2);
  },
);

it.each(["partial", "failed", "completed", "stopped", "interrupted"] as const)(
  "leaves the setup %s notice out of the header and composer",
  (executionState) => {
    const view = render(sessionStatus("setup", executionState));
    const label = i18n.t(`session.executionState.${executionState}`);
    expect(screen.queryByText(label)).toBeNull();
    expect(screen.queryByText(i18n.t("session.stateStreaming"))).toBeNull();
    expect(screen.queryByText(i18n.t("session.setupRunning"))).toBeNull();
    if (executionState !== "completed") {
      view.rerender(sessionStatus("playing", executionState));
      expect(screen.getAllByText(label)).toHaveLength(2);
    }
  },
);

it.each(["generating", "updating"] as const)(
  "describes %s as opening preparation during setup",
  (executionState) => {
    const view = render(sessionStatus("setup", executionState, true));
    expect(screen.getAllByText(i18n.t("session.setupRunning"))).toHaveLength(2);
    expect(
      screen.queryByText(i18n.t(`session.executionState.${executionState}`)),
    ).toBeNull();
    view.rerender(sessionStatus("playing", executionState, true));
    expect(
      screen.getAllByText(i18n.t(`session.executionState.${executionState}`)),
    ).toHaveLength(2);
  },
);

it("shows the waiting chip only while the story waits and opens the dialog from it", async () => {
  await i18n.changeLanguage("en-US");
  const open = vi.fn();
  const base = {
    menu: null,
    pluginViews: [],
    t: i18n.t,
    sessionId: "s",
    sessionPhase: "playing" as const,
    locale: "en-US",
    turnCount: 1,
    world: null,
    executing: false,
    viewMode: "parsed" as const,
    isRightCollapsed: true,
    onViewModeChange: vi.fn(),
    onToggleRightPanel: vi.fn(),
    onOpenSuspensions: open,
    onBackToWorldSelect: vi.fn(),
  };
  const view = render(<GameViewHeader {...base} suspensionsCount={0} />);
  expect(screen.queryByText(/Waiting for you/)).toBeNull();
  view.rerender(<GameViewHeader {...base} suspensionsCount={2} />);
  const chip = screen.getByRole("button", { name: "Waiting for you · 2" });
  fireEvent.click(chip);
  expect(open).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Read" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stage" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Side panel" })).toBeTruthy();
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
          menu={null}
          pluginViews={[]}
          t={i18n.t}
          sessionId="translated-session"
          sessionPhase="playing"
          locale={session.locale}
          turnCount={1}
          world={world}
          executing={false}
          viewMode="parsed"
          isRightCollapsed
          onViewModeChange={vi.fn()}
          onToggleRightPanel={vi.fn()}
          onOpenSuspensions={vi.fn()}
          suspensionsCount={0}
          onBackToWorldSelect={vi.fn()}
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
