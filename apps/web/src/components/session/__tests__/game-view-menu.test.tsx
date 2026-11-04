import { useContext, type ComponentProps, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import type { SessionRecord } from "@/services/api.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import { GameView } from "../game-view.js";
import type { StageView } from "../stage/StageView.js";

const actions = vi.hoisted(() => ({
  abortActiveTurn: vi.fn<() => Promise<void>>(),
  setAutoAdvanceLimit: vi.fn<(limit: number) => Promise<void>>(),
  loadSessionPlugins: vi.fn(async () => {}),
  resetSession: vi.fn(),
  loadWorldSessions: vi.fn(),
}));
const flags = vi.hoisted(() => ({
  developer: false,
  confirm: vi.fn<(request: unknown) => Promise<boolean>>(),
  exported: vi.fn(),
}));
vi.mock("@/settings/use-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/settings/use-settings.js")>()),
  useSetting: () => [flags.developer, vi.fn()],
}));
vi.mock("@/lib/confirm-channel.js", () => ({
  requestConfirm: (request: unknown) => flags.confirm(request),
}));
vi.mock("@/lib/chat-export.js", () => ({
  exportChat: (...args: unknown[]) => flags.exported(...args),
}));
// Keep GameView, its view switcher and auto-advance chip mounted together;
// scene content and unrelated data loading do not affect this regression.
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: useContext(SessionStateContext), ...actions }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/components/ui/resizable.js", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => null,
}));
vi.mock("@/hooks/use-media-query.js", () => ({ useMediaQuery: () => false }));
vi.mock("@/hooks/use-slot-config.js", () => ({
  useSlotConfig: () => ({ resolvedSlots: [], refresh: vi.fn() }),
}));
vi.mock("@/theme-system/use-theme-layout.js", () => ({
  useThemeLayout: () => ({ backdrop: "plain" }),
}));
vi.mock("@/stores/ui-slot-store.js", () => ({ useUiSlot: () => undefined }));
vi.mock("@/settings/SettingsDialog.js", () => ({ SettingsDialog: () => null }));
vi.mock("../game-view/use-plugin-views.js", () => ({
  usePluginViews: () => ({ views: [], status: "ready" }),
}));
vi.mock("../plugin-view-consent.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugin-view-consent.js")>();
  return {
    ...actual,
    usePluginViewConsent: () => ({ isAllowed: () => true }),
  };
});
vi.mock("../game-view/use-game-view-composer.js", () => ({
  useGameViewComposer: () => ({
    pendingDrafts: [],
    suspensions: [
      {
        id: "q1",
        sessionId: "session",
        turnId: "t",
        runtimeId: "r",
        pluginId: "p",
        reason: "Which way?",
        createdAt: new Date().toISOString(),
        resumeSchema: { enum: ["left", "right"] },
      },
    ],
  }),
}));
vi.mock("../right-panel-state.js", () => ({ useRightPanelState: () => ({}) }));
vi.mock("../stage/use-stage-media-preload.js", () => ({
  useStageMediaPreload: () => {},
}));
vi.mock("../game-view/connection-status.js", () => ({
  ConnectionStatus: () => null,
}));
vi.mock("../session-music.js", () => ({
  SessionMusic: () => null,
  MusicMenuControls: () => null,
}));
vi.mock("../session-settings-drawer.js", () => ({
  SessionSettingsDrawer: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">drawer</div> : null,
}));
vi.mock("../session-backdrop.js", () => ({ SessionBackdrop: () => null }));
vi.mock("../scene-hud.js", () => ({ SceneHud: () => null }));
vi.mock("../session-dimensions-panel.js", () => ({
  SessionDimensionsPanel: () => null,
}));
vi.mock("../memory-index-notice.js", () => ({ MemoryIndexNotice: () => null }));
vi.mock("../right-panel.js", () => ({ RightPanel: () => null }));
vi.mock("../chat-messages.js", () => ({ ChatMessages: () => null }));
vi.mock("../game-view/message-composer.js", () => ({
  MessageComposer: () => null,
}));
vi.mock("../stage/StageView.js", () => ({
  StageView: ({ onToggleImmersive }: ComponentProps<typeof StageView>) => (
    <button onClick={onToggleImmersive}>Toggle immersive stage</button>
  ),
}));

const session: SessionRecord = {
  id: "session",
  worldId: "world",
  status: "active",
  phase: "playing",
  locale: "en-US",
  autoAdvanceLimit: 2,
  completedPlayerTurns: 1,
  setupRuntimes: {},
  seats: [
    { id: "human", role: "host", controller: "human", characters: "auto" },
  ],
  activePlugins: [],
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const view = () => (
  <SessionStateContext.Provider value={{ ...initialState, session }}>
    <GameView session={session} />
  </SessionStateContext.Provider>
);

beforeEach(async () => {
  vi.clearAllMocks();
  flags.developer = false;
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);

const openMenu = () =>
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));

it("keeps the header to the listed controls and no left rail", () => {
  render(view());
  const header = screen.getByTestId("session-header");
  const names = [...header.querySelectorAll("button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent,
  );
  expect(names).toEqual(
    expect.arrayContaining(["Read", "Stage", "Menu", "Side panel"]),
  );
  for (const gone of ["Settings", "Undo", "More", "Studio Config"])
    expect(names).not.toContain(gone);
  expect(screen.queryByText(/STUDIO/)).toBeNull();
});

it("opens the answer dialog from the waiting chip with the new words", () => {
  render(view());
  fireEvent.click(screen.getByRole("button", { name: "Waiting for you · 1" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Waiting for you")).toBeTruthy();
  expect(within(dialog).getByText("Which way?")).toBeTruthy();
});

it("opens this game's settings and the settings dialog from the menu", () => {
  render(view());
  openMenu();
  fireEvent.click(
    screen.getByRole("button", { name: "This game's settings…" }),
  );
  expect(screen.getByText("drawer")).toBeTruthy();
});

it("asks before starting over and only then resets", async () => {
  render(view());
  flags.confirm.mockResolvedValueOnce(false);
  openMenu();
  fireEvent.click(screen.getByRole("button", { name: "Start over" }));
  await vi.waitFor(() => expect(flags.confirm).toHaveBeenCalledTimes(1));
  expect(flags.confirm.mock.calls[0]![0]).toMatchObject({
    title: "Start over?",
  });
  expect(actions.resetSession).not.toHaveBeenCalled();
  flags.confirm.mockResolvedValueOnce(true);
  openMenu();
  fireEvent.click(screen.getByRole("button", { name: "Start over" }));
  await vi.waitFor(() => expect(actions.resetSession).toHaveBeenCalledTimes(1));
});

it("exports the chat from the menu", () => {
  render(view());
  openMenu();
  fireEvent.click(screen.getByRole("button", { name: "Export save" }));
  expect(flags.exported).toHaveBeenCalledTimes(1);
  expect(flags.exported.mock.calls[0]![1]).toBe("session");
});

it("falls back to the read view when developer mode turns off on a developer view", () => {
  flags.developer = true;
  const { rerender } = render(view());
  openMenu();
  fireEvent.click(screen.getByRole("button", { name: "Raw view" }));
  expect(
    screen.getByRole("button", { name: "Read" }).getAttribute("aria-pressed"),
  ).toBe("false");
  flags.developer = false;
  rerender(view());
  expect(
    screen.getByRole("button", { name: "Read" }).getAttribute("aria-pressed"),
  ).toBe("true");
  openMenu();
  expect(screen.queryByRole("button", { name: "Raw view" })).toBeNull();
});
