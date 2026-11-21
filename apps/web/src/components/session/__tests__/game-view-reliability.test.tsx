import {
  useContext,
  useEffect,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PanelImperativeHandle } from "react-resizable-panels";
import i18n from "@/i18n/index.js";
import type { SessionRecord } from "@/services/api.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import type { SessionState } from "@/stores/session-store/types.js";
import {
  SessionModelUsesContext,
  type SessionModelUse,
} from "../provider-failure-notice.js";
import { GameView } from "../game-view.js";
import type { StageView } from "../stage/StageView.js";

const mocks = vi.hoisted(() => ({
  mobile: false,
  tablet: false,
  collapsed: false,
  isCollapsed: vi.fn<() => boolean>(),
  collapse: vi.fn(),
  expand: vi.fn(),
  seenModelUses: [] as (readonly SessionModelUse[])[],
  resolvedSlots: [
    {
      slotId: "story",
      presetId: "p",
      preset: { id: "p", name: "P", provider: "openai", model: "gpt-4o" },
      label: "story",
      tag: "text",
      hasCredentials: true,
    },
  ],
  loadSessionPlugins: vi.fn(async () => {}),
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: useContext(SessionStateContext),
    loadSessionPlugins: mocks.loadSessionPlugins,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/components/ui/resizable.js", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({
    id,
    panelRef,
    children,
  }: {
    id?: string;
    panelRef?: RefObject<PanelImperativeHandle | null>;
    children: ReactNode;
  }) => {
    useEffect(() => {
      if (id !== "right-panel" || !panelRef) return;
      panelRef.current = {
        isCollapsed: mocks.isCollapsed,
        collapse: mocks.collapse,
        expand: mocks.expand,
      } as unknown as PanelImperativeHandle;
      return () => {
        panelRef.current = null;
      };
    }, [id, panelRef]);
    return <div>{children}</div>;
  },
  ResizableHandle: () => null,
}));
vi.mock("@/hooks/use-media-query.js", () => ({
  useMediaQuery: (query: string) =>
    query.includes("767.98") ? mocks.mobile : mocks.tablet,
}));
vi.mock("@/hooks/use-slot-config.js", () => ({
  useSlotConfig: () => ({
    resolvedSlots: mocks.resolvedSlots,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/theme-system/use-theme-layout.js", () => ({
  useThemeLayout: () => ({ backdrop: "plain" }),
}));
vi.mock("@/stores/ui-slot-store.js", () => ({ useUiSlot: () => undefined }));
vi.mock("@/settings/SettingsDialog.js", () => ({ SettingsDialog: () => null }));
vi.mock("../game-view/use-plugin-themes.js", () => ({
  usePluginThemes: () => ({ source: undefined, reload: vi.fn() }),
}));
vi.mock("../game-view/use-plugin-views.js", () => ({
  usePluginViews: () => ({ views: [], status: "ready", reload: vi.fn() }),
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
  MusicMenuControls: () => null,
}));
vi.mock("../session-backdrop.js", () => ({ SessionBackdrop: () => null }));
vi.mock("../scene-hud.js", () => ({ SceneHud: () => null }));
vi.mock("../session-dimensions-panel.js", () => ({
  SessionDimensionsPanel: () => null,
}));
vi.mock("../memory-index-notice.js", () => ({ MemoryIndexNotice: () => null }));
vi.mock("../right-panel.js", () => ({ RightPanel: () => null }));
vi.mock("../chat-messages.js", () => ({
  ChatMessages: () => {
    mocks.seenModelUses.push(useContext(SessionModelUsesContext));
    return null;
  },
}));
vi.mock("../game-view/message-composer.js", () => ({
  MessageComposer: () => null,
}));
vi.mock("../stage/StageView.js", () => ({
  StageView: ({ onToggleImmersive }: ComponentProps<typeof StageView>) => (
    <button type="button" onClick={onToggleImmersive}>
      Toggle immersive stage
    </button>
  ),
}));

const baseSession: SessionRecord = {
  id: "session-1",
  worldId: "world-1",
  autoAdvanceLimit: 3,
  status: "active",
  phase: "playing",
  locale: "en-US",
  completedPlayerTurns: 1,
  setupRuntimes: {},
  seats: [
    { id: "human", role: "host", controller: "human", characters: "auto" },
  ],
  activePlugins: ["narrator"],
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const basePlugins: SessionState["sessionPlugins"] = [
  {
    id: "narrator",
    displayName: "Narrator",
    description: "",
    active: true,
    locked: false,
    executionMode: "code",
    hostState: "loaded",
    kind: "plugin",
    source: "builtin",
    runtimeCount: 1,
    runtimes: [
      {
        id: "narrator/story",
        runtimeType: "agent",
        trigger: { type: "auto" },
        execution: "sync",
        turnCompletion: { mode: "await" },
        model: "story",
        outputKind: "story",
      },
    ],
    tools: [],
    userSettings: [],
    languages: { text: ["en"], instructions: ["en"] },
    provides: [],
    requires: [],
    optional: [],
    conflicts: [],
    extensions: [],
    eventTopics: [],
    tags: [],
    serverCodeApproved: true,
    sessionState: "active",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = false;
  mocks.tablet = false;
  mocks.collapsed = false;
  mocks.seenModelUses = [];
  mocks.isCollapsed.mockImplementation(() => mocks.collapsed);
  mocks.collapse.mockImplementation(() => {
    mocks.collapsed = true;
  });
  mocks.expand.mockImplementation(() => {
    mocks.collapsed = false;
  });
});

afterEach(cleanup);

it("memoizes SessionModelUsesContext across unrelated GameView renders", () => {
  const baseState: SessionState = {
    ...initialState,
    session: baseSession,
    sessionPlugins: basePlugins,
  };
  const { rerender } = render(
    <SessionStateContext.Provider value={baseState}>
      <GameView session={baseSession} />
    </SessionStateContext.Provider>,
  );

  const initialUses = mocks.seenModelUses.at(-1);
  expect(initialUses).toEqual([
    { slotId: "story", provider: "openai", hasCredentials: true },
  ]);

  // Simulate an unrelated render (e.g., streaming message update / keystroke).
  rerender(
    <SessionStateContext.Provider
      value={{
        ...baseState,
        messages: [
          {
            id: "m1",
            role: "user",
            content: "Hello",
            timestamp: "2026-01-01T00:00:01Z",
          },
        ],
      }}
    >
      <GameView session={baseSession} />
    </SessionStateContext.Provider>,
  );

  expect(mocks.seenModelUses.at(-1)).toBe(initialUses);

  // Updating runtimeModelOverrides recomputes the context value.
  const nextSession: SessionRecord = {
    ...baseSession,
    runtimeModelOverrides: { "narrator/story": "fast" },
  };
  rerender(
    <SessionStateContext.Provider
      value={{ ...baseState, session: nextSession }}
    >
      <GameView session={nextSession} />
    </SessionStateContext.Provider>,
  );

  expect(mocks.seenModelUses.at(-1)).not.toBe(initialUses);
});

it("collapses and restores the desktop right panel on immersive transitions without misfiring on breakpoint resizes", () => {
  const state: SessionState = {
    ...initialState,
    session: baseSession,
    sessionPlugins: basePlugins,
  };
  const renderView = () => (
    <SessionStateContext.Provider value={state}>
      <GameView session={baseSession} />
    </SessionStateContext.Provider>
  );
  const { rerender } = render(renderView());

  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.viewStage") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Toggle immersive stage" }),
  );
  expect(mocks.isCollapsed).toHaveBeenCalledTimes(1);
  expect(mocks.collapse).toHaveBeenCalledTimes(1);
  expect(mocks.expand).not.toHaveBeenCalled();

  // Resizing desktop -> tablet -> desktop while immersive must not query or
  // overwrite the saved prior collapse state.
  mocks.tablet = true;
  rerender(renderView());
  mocks.tablet = false;
  rerender(renderView());
  expect(mocks.isCollapsed).toHaveBeenCalledTimes(1);
  expect(mocks.collapse).toHaveBeenCalledTimes(1);
  expect(mocks.expand).not.toHaveBeenCalled();

  // Exiting immersive on desktop restores the previously expanded right rail.
  fireEvent.click(
    screen.getByRole("button", { name: "Toggle immersive stage" }),
  );
  expect(mocks.expand).toHaveBeenCalledTimes(1);
});

it("does not expand the desktop panel when immersive mode is exited on a compact viewport", () => {
  const state: SessionState = {
    ...initialState,
    session: baseSession,
    sessionPlugins: basePlugins,
  };
  const renderView = () => (
    <SessionStateContext.Provider value={state}>
      <GameView session={baseSession} />
    </SessionStateContext.Provider>
  );
  const { rerender } = render(renderView());

  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.viewStage") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Toggle immersive stage" }),
  );
  expect(mocks.collapse).toHaveBeenCalledTimes(1);

  mocks.tablet = true;
  rerender(renderView());
  fireEvent.click(
    screen.getByRole("button", { name: "Toggle immersive stage" }),
  );
  expect(mocks.expand).not.toHaveBeenCalled();

  mocks.tablet = false;
  rerender(renderView());
  expect(mocks.expand).not.toHaveBeenCalled();
});
