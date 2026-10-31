import { type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BASE_ACTION_KIND_RULES,
  ROLE_ACTION_KINDS,
  type SeatRole,
} from "@covel/shared";
import i18n from "@/i18n/index.js";
import {
  SessionActionsContext,
  SessionStateContext,
  type SessionActions,
} from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import type {
  SessionState,
  StreamMessage,
} from "@/stores/session-store/types.js";
import { GameView } from "../game-view.js";
import type { PluginViewEntry } from "../game-view/use-plugin-views.js";
import {
  appendStreamingText,
  resetStreamingText,
  clearAllStreamingText,
} from "@/stores/streaming-text-store.js";
import {
  setActiveSession,
  replaceSessionPluginData,
} from "@/stores/plugin-data-store.js";
import { applyUiSlotEvent, clearUiSlots } from "@/stores/ui-slot-store.js";
import consoleSpec from "../../../../../../plugins/dm-console/ui/dm-console.json";
const mocks = vi.hoisted(() => ({ entries: [] as PluginViewEntry[] }));
vi.mock("../game-view/use-plugin-views.js", () => ({
  usePluginViews: () => ({
    views: mocks.entries,
    status: "ready",
    reload: vi.fn(),
  }),
}));
vi.mock("../use-session-bridge.js", () => ({
  useSessionBridge: () => ({ projection: null }),
}));
vi.mock("@/settings/use-settings.js", () => ({ useSetting: () => [false] }));
vi.mock("@/hooks/use-auto-scroll.js", () => ({
  useAutoScroll: () => ({ scrollRef: () => {}, showJumpButton: false }),
}));
vi.mock("../chat-messages/use-load-older-messages.js", () => ({
  useLoadOlderMessages: () => ({}),
}));
vi.mock("../chat-messages/use-image-generation.js", () => ({
  useImageGeneration: () => ({
    isImageGenActive: false,
    generatingImage: false,
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
vi.mock("@/settings/SettingsDialog.js", () => ({ SettingsDialog: () => null }));
vi.mock("../plugin-view-consent.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugin-view-consent.js")>();
  return {
    ...actual,
    usePluginViewConsent: () => ({
      isAllowed: () => true,
      isCurrent: () => () => true,
    }),
  };
});
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

const entry: PluginViewEntry = {
  mode: "plugin:dm-console:dm-console",
  pluginId: "dm-console",
  viewId: "dm-console",
  label: "DM Console",
  pluginName: "DM Console",
  spec: consoleSpec,
};
const community: PluginViewEntry = {
  mode: "plugin:community:desk",
  pluginId: "community",
  viewId: "desk",
  label: "Community desk",
  pluginName: "Community",
  spec: { ...consoleSpec, id: "desk", label: "Community desk" },
};
let state: SessionState;
const actions = {
  loadSessionPlugins: vi.fn(async () => {}),
  clearRestoredInput: vi.fn(),
  sendMessage: vi.fn(() => true),
  submitComposerAction: vi.fn(() => true),
  clearInteractionDrafts: vi.fn(),
  submitBlock: vi.fn(),
  upsertInteractionDraft: vi.fn(),
  abortActiveTurn: vi.fn(async () => {}),
  loadOlderMessages: vi.fn(async () => {}),
  submitInteraction: vi.fn(async () => ({ rejected: [] })),
} as unknown as SessionActions;
function shell(children: ReactNode) {
  return (
    <SessionActionsContext.Provider value={actions}>
      <SessionStateContext.Provider value={state}>
        {children}
      </SessionStateContext.Provider>
    </SessionActionsContext.Provider>
  );
}
function message(id: string, content: string, kind = "story"): StreamMessage {
  return { id, content, kind, role: "assistant", timestamp: "now" };
}
function setRole(role: SeatRole) {
  state = {
    ...state,
    session: {
      ...state.session!,
      seats: [{ id: "human", role, controller: "human", characters: [] }],
    },
    sessionActionKinds: {
      kinds: Object.entries(BASE_ACTION_KIND_RULES).map(([kind, rule]) => ({
        kind,
        ...rule,
        roles: ["player", "host", "spectator"],
        source: "framework",
        display: { label: kind },
      })),
      seats: [
        {
          seatId: "human",
          role,
          controller: "human",
          allowed: [...ROLE_ACTION_KINDS[role]],
        },
      ],
    },
  };
}
function choose(label: string) {
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.pluginViews") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp("^" + label) }),
  );
}
function back() {
  fireEvent.click(
    within(screen.getByTestId("plugin-view-bar")).getByRole("button", {
      name: i18n.t("session.backToDefaultView"),
    }),
  );
}
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  mocks.entries = [entry, community];
  state = {
    ...initialState,
    session: {
      id: "s",
      worldId: "w",
      status: "active",
      phase: "playing",
      locale: "en-US",
      completedPlayerTurns: 1,
      autoAdvanceLimit: 2,
      setupRuntimes: {},
      seats: [],
      activePlugins: [],
      createdAt: "now",
      updatedAt: "now",
    },
    messages: [message("public", "PUBLIC-STORY")],
  };
  setRole("host");
  setActiveSession("s");
});
afterEach(() => {
  cleanup();
  clearAllStreamingText();
  clearUiSlots();
  setActiveSession(null);
});

it("shares one host draft and mode through real bundled and community view renderers", () => {
  const view = render(shell(<GameView session={state.session!} />));
  fireEvent.click(screen.getByTestId("composer-mode-direct"));
  fireEvent.change(screen.getByTestId("game-composer-input"), {
    target: { value: "Keep this direction" },
  });
  choose("DM Console");
  expect(screen.getAllByTestId("game-composer")).toHaveLength(1);
  expect(
    (screen.getByTestId("game-composer-input") as HTMLInputElement).value,
  ).toBe("Keep this direction");
  expect(screen.getByText("PUBLIC-STORY")).toBeTruthy();
  choose("Community desk");
  expect(
    (screen.getByTestId("game-composer-input") as HTMLInputElement).value,
  ).toBe("Keep this direction");
  back();
  expect(
    (screen.getByTestId("game-composer-input") as HTMLInputElement).value,
  ).toBe("Keep this direction");
  choose("DM Console");
  fireEvent.click(
    document.querySelector<HTMLButtonElement>(".ui-composer-submit")!,
  );
  expect(actions.submitComposerAction).toHaveBeenCalledExactlyOnceWith(
    { kind: "direct", text: "Keep this direction", seatId: "human" },
    undefined,
  );
  expect(
    (screen.getByTestId("game-composer-input") as HTMLInputElement).value,
  ).toBe("");
  state = {
    ...state,
    restoredInput: {
      requestId: "stopped",
      content: "Restore once",
      kind: "direct",
    },
  };
  view.rerender(shell(<GameView session={state.session!} />));
  back();
  choose("Community desk");
  expect(actions.clearRestoredInput).toHaveBeenCalledExactlyOnceWith("stopped");
  expect(
    (screen.getByTestId("game-composer-input") as HTMLInputElement).value,
  ).toBe("Restore once");
});

it.each(["host", "spectator", "player"] as const)(
  "keeps %s permissions when opening a console",
  (role) => {
    setRole(role);
    render(shell(<GameView session={state.session!} />));
    choose("DM Console");
    if (role === "host")
      expect(screen.getByTestId("composer-mode-direct")).toBeTruthy();
    else expect(screen.queryByTestId("composer-mode-direct")).toBeNull();
    if (role !== "player") {
      if (role === "host")
        fireEvent.click(screen.getByTestId("composer-mode-advance"));
      fireEvent.click(
        document.querySelector<HTMLButtonElement>(".ui-composer-submit")!,
      );
      expect(actions.submitComposerAction).toHaveBeenCalledExactlyOnceWith(
        { kind: "advance", seatId: "human" },
        undefined,
      );
    }
  },
);

it("renders public cast, a separate pending interaction and stream resets, while excluding private data", async () => {
  const form = {
    ...message("form", "", "plugin"),
    turnId: "turn",
    block: {
      type: "interactive_form",
      data: {
        interactionId: "identity",
        title: "PUBLIC-FORM",
        fields: [
          { name: "name", label: "Public name", type: "text", required: true },
          {
            name: "attribute",
            label: "Attribute",
            type: "select",
            required: true,
            options: [{ value: "focus", label: "Focus" }],
          },
        ],
        submitLabel: "Answer form",
      },
      meta: { turnId: "turn", interactionId: "identity" },
    },
  };
  state = {
    ...state,
    messages: [
      ...state.messages,
      message("stream_turn_story", "", "story"),
      message("concealed", "CONCEALED-SECRET", "concealed"),
      {
        ...message("unknown-block", "", "plugin"),
        block: { type: "tool-traffic", data: { value: "TOOL-SECRET" } },
      },
      message("continuation", "CONTINUATION-SECRET", "summary"),
      form,
    ],
  };
  replaceSessionPluginData("s", {
    private: {
      "_hidden.planned": { secret: "HIDDEN-PLOT" },
      intent: { secret: "ACTOR-INTENT" },
    },
    "dm-console": { settings: { key: "PROVIDER-SECRET" } },
  });
  applyUiSlotEvent("s", "ui.slot.changed", {
    slot: "stage.cast@1",
    provider: { pluginId: "cast", runtimeId: "cast" },
    value: {
      retainWhenEmpty: false,
      actors: [
        {
          characterId: "mara",
          displayName: "PUBLIC-CAST",
          type: "npc",
          description: "Public performer",
        },
      ],
    },
    revision: "one",
  });
  const view = render(shell(<GameView session={state.session!} />));
  choose("DM Console");
  expect(screen.getByText("PUBLIC-STORY")).toBeTruthy();
  expect(screen.getByText("PUBLIC-CAST")).toBeTruthy();
  expect(screen.getAllByText("PUBLIC-FORM")).toHaveLength(1);
  expect(
    screen.getByTestId("game-composer-input").hasAttribute("disabled"),
  ).toBe(true);
  vi.mocked(actions.submitInteraction).mockResolvedValueOnce({
    rejected: [{ field: "name", message: "Choose another public name" }],
  });
  fireEvent.change(screen.getByLabelText(/Public name/), {
    target: { value: "Mara" },
  });
  const attribute = screen.getByRole("combobox", {
    name: "Attribute",
  }) as HTMLSelectElement;
  expect(attribute.options[1]?.text).toBe("Focus");
  fireEvent.change(attribute, { target: { value: "focus" } });
  expect(attribute.value).toBe("focus");
  fireEvent.click(screen.getByRole("button", { name: "Answer form" }));
  await waitFor(() =>
    expect(actions.submitInteraction).toHaveBeenCalledWith(
      "form",
      "turn",
      "identity",
      "form",
      { name: "Mara", attribute: "focus" },
    ),
  );
  expect(await screen.findByText("Choose another public name")).toBeTruthy();
  expect((screen.getByLabelText(/Public name/) as HTMLInputElement).value).toBe(
    "Mara",
  );
  fireEvent.change(screen.getByLabelText(/Public name/), {
    target: { value: "Ivo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Answer form" }));
  await waitFor(() =>
    expect(actions.submitInteraction).toHaveBeenLastCalledWith(
      "form",
      "turn",
      "identity",
      "form",
      { name: "Ivo", attribute: "focus" },
    ),
  );
  state = { ...state, submittedBlockIds: new Set(["form"]) };
  view.rerender(shell(<GameView session={state.session!} />));
  expect(screen.getByText("No pending interactions.")).toBeTruthy();

  act(() => appendStreamingText("stream_turn_story", "Discarded prefix"));
  expect(screen.getByText("Discarded prefix")).toBeTruthy();
  act(() => {
    resetStreamingText("stream_turn_story");
    appendStreamingText("stream_turn_story", "Replacement stream");
  });
  expect(screen.queryByText("Discarded prefix")).toBeNull();
  expect(screen.getByText("Replacement stream")).toBeTruthy();
  state = {
    ...state,
    submittedBlockIds: new Set(),
    messages: [
      message("committed", "FINAL-STORY"),
      form,
      { id: "later", role: "user", content: "PUBLIC-ANSWER", timestamp: "now" },
    ],
  };
  view.rerender(shell(<GameView session={state.session!} />));
  expect(screen.getByText("FINAL-STORY")).toBeTruthy();
  expect(screen.queryByText("Replacement stream")).toBeNull();
  expect(screen.getByText("No pending interactions.")).toBeTruthy();
  for (const secret of [
    "TOOL-SECRET",
    "HIDDEN-PLOT",
    "ACTOR-INTENT",
    "PROVIDER-SECRET",
    "CONCEALED-SECRET",
    "CONTINUATION-SECRET",
  ])
    expect(document.body.textContent).not.toContain(secret);
});

it("masks live context in nested plugin messages and snapshot panels", () => {
  state = {
    ...state,
    messages: [
      ...state.messages,
      {
        ...message("nested", "", "plugin-message"),
        block: {
          type: "plugin_message",
          data: {
            pluginId: "community",
            state: {},
            specs: [
              { alwaysRender: true, view: { component: "SessionComposer" } },
            ],
          },
        },
      },
    ],
  };
  render(shell(<GameView session={state.session!} />));
  choose("DM Console");
  expect(screen.getAllByTestId("game-composer")).toHaveLength(1);
  expect(
    screen.getByText(
      "Session controls are available only in the current live plugin view.",
    ),
  ).toBeTruthy();
});

it("retains busy drafts, keeps Stop outside plugin content and falls back when a provider leaves", () => {
  const view = render(shell(<GameView session={state.session!} />));
  choose("DM Console");
  fireEvent.click(screen.getByTestId("composer-mode-direct"));
  fireEvent.change(screen.getByTestId("game-composer-input"), {
    target: { value: "Admitted direction" },
  });
  fireEvent.click(
    document.querySelector<HTMLButtonElement>(".ui-composer-submit")!,
  );
  expect(actions.submitComposerAction).toHaveBeenCalledOnce();
  vi.mocked(actions.submitComposerAction).mockReturnValueOnce(false);
  fireEvent.change(screen.getByTestId("game-composer-input"), {
    target: { value: "Second draft" },
  });
  fireEvent.click(
    document.querySelector<HTMLButtonElement>(".ui-composer-submit")!,
  );
  expect(
    (screen.getByTestId("game-composer-input") as HTMLInputElement).value,
  ).toBe("Second draft");
  state = { ...state, executing: true };
  view.rerender(shell(<GameView session={state.session!} />));
  fireEvent.click(
    within(screen.getByTestId("plugin-view-bar")).getByRole("button", {
      name: i18n.t("session.abortTurn"),
    }),
  );
  expect(actions.abortActiveTurn).toHaveBeenCalledOnce();
  mocks.entries = [community];
  view.rerender(shell(<GameView session={state.session!} />));
  expect(screen.queryByTestId("plugin-view-bar")).toBeNull();
  expect(
    (screen.getByTestId("game-composer-input") as HTMLInputElement).value,
  ).toBe("Second draft");
});
