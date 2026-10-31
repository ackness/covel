import { useContext, type ComponentProps, type ReactNode } from "react";
import {
  act,
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
import { initialState, reducer } from "@/stores/session-store/reducer.js";
import type { SessionState } from "@/stores/session-store/types.js";
import { GameView } from "../game-view.js";
import type { StageView } from "../stage/StageView.js";

const actions = vi.hoisted(() => ({
  abortActiveTurn: vi.fn<() => Promise<void>>(),
  setAutoAdvanceLimit: vi.fn<(limit: number) => Promise<void>>(),
  loadSessionPlugins: vi.fn(async () => {}),
}));
// Keep GameView, its view switcher and AutoAdvanceControl mounted together;
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
vi.mock("../plugin-view-consent.js", () => ({
  usePluginViewConsent: () => ({ isAllowed: () => true }),
}));
vi.mock("../game-view/use-game-view-composer.js", () => ({
  useGameViewComposer: () => ({ pendingDrafts: [], suspensions: [] }),
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
  MusicToggle: () => null,
}));
vi.mock("../session-backdrop.js", () => ({ SessionBackdrop: () => null }));
vi.mock("../scene-hud.js", () => ({ SceneHud: () => null }));
vi.mock("../session-dimensions-panel.js", () => ({
  SessionDimensionsPanel: () => null,
}));
vi.mock("../memory-index-notice.js", () => ({ MemoryIndexNotice: () => null }));
vi.mock("../left-panel.js", () => ({ LeftPanel: () => null }));
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
const progress = {
  requestId: "request",
  rootId: "root",
  phase: "running" as const,
  round: 1,
  limit: 2,
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it.each(["chat", "stage", "immersive stage"])(
  "clears stopped progress and keeps the controls usable in %s",
  async (mode) => {
    let state: SessionState = {
      ...initialState,
      session,
      executing: true,
      advance: progress,
    };
    const view = () => (
      <SessionStateContext.Provider value={state}>
        <GameView session={session} />
      </SessionStateContext.Provider>
    );
    const { rerender } = render(view());
    actions.abortActiveTurn.mockImplementation(async () => {
      state = reducer(state, {
        type: "SET_ADVANCE",
        advance: { ...progress, phase: "stopped", reason: "player-stop" },
      });
      rerender(view());
    });
    actions.setAutoAdvanceLimit.mockResolvedValue();
    if (mode !== "chat") {
      fireEvent.click(
        screen.getByRole("button", {
          name: i18n.t("session.viewStageAria"),
        }),
      );
      if (mode === "immersive stage") {
        fireEvent.click(
          screen.getByRole("button", { name: "Toggle immersive stage" }),
        );
      }
    }
    const controls = () => within(screen.getByTestId("auto-advance-control"));
    expect(controls().getByRole("status").textContent).toContain("1 / 2");
    await act(async () => {
      fireEvent.click(
        controls().getByRole("button", {
          name: i18n.t("session.autoAdvanceStop"),
        }),
      );
    });
    expect(actions.abortActiveTurn).toHaveBeenCalledTimes(1);
    expect(controls().queryAllByRole("status")).toHaveLength(0);
    expect(
      controls().queryByRole("button", {
        name: i18n.t("session.autoAdvanceStop"),
      }),
    ).toBeNull();
    // The terminal event clears the projection after the stopped notification.
    state = reducer(state, { type: "SET_EXECUTING", value: false });
    state = reducer(state, { type: "SET_ADVANCE", advance: null });
    rerender(view());
    expect(controls().queryAllByRole("status")).toHaveLength(0);
    expect(controls().queryByRole("combobox")).toBeNull();
    expect(actions.setAutoAdvanceLimit).not.toHaveBeenCalled();
  },
);
