import { useContext, type ComponentProps, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import type { PluginViewEntry } from "../game-view/use-plugin-views.js";
import { viewEntry } from "./plugin-view-fixtures.js";
import type { SessionRecord, UISpecsResponse } from "@/services/api.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import type { SessionState } from "@/stores/session-store/types.js";
import { GameView } from "../game-view.js";
import type { PluginViewHost } from "../plugin-view-host.js";
import type { StageView } from "../stage/StageView.js";

const surfaces = vi.hoisted(() => ({
  views: [] as PluginViewEntry[],
  composers: [] as PluginViewEntry[],
  allowed: true,
  grant:
    vi.fn<
      (entry: PluginViewEntry, isCurrent: () => boolean) => Promise<void>
    >(),
  denied: new Set<string>(),
  reload: vi.fn<() => Promise<void>>(),
  narrow: false,
  realDiscovery: false,
  fetch: vi.fn<typeof import("@/services/api.js").fetchUiSpecs>(),
}));
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
vi.mock("@/hooks/use-media-query.js", () => ({
  useMediaQuery: () => surfaces.narrow,
}));
vi.mock("@/hooks/use-slot-config.js", () => ({
  useSlotConfig: () => ({ resolvedSlots: [], refresh: vi.fn() }),
}));
vi.mock("@/theme-system/use-theme-layout.js", () => ({
  useThemeLayout: () => ({ backdrop: "plain" }),
}));
vi.mock("@/stores/ui-slot-store.js", () => ({ useUiSlot: () => undefined }));
vi.mock("@/settings/SettingsDialog.js", () => ({ SettingsDialog: () => null }));
vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  fetchUiSpecs: surfaces.fetch,
}));
vi.mock("../game-view/use-plugin-themes.js", () => ({
  usePluginThemes: () => ({ source: undefined, reload: vi.fn() }),
}));
vi.mock("../game-view/use-plugin-views.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../game-view/use-plugin-views.js")>();
  return {
    usePluginViews: (...args: Parameters<typeof actual.usePluginViews>) =>
      surfaces.realDiscovery
        ? actual.usePluginViews(...args)
        : {
            views: surfaces.views,
            composers: surfaces.composers,
            status: "ready",
            reload: surfaces.reload,
          },
  };
});
vi.mock("../plugin-view-consent.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugin-view-consent.js")>();
  return {
    ...actual,
    usePluginViewConsent: () => ({
      isAllowed: (entry: PluginViewEntry) =>
        surfaces.allowed && !surfaces.denied.has(entry.mode),
      isCurrent: () => () => surfaces.allowed,
      ready: () => true,
      grant: surfaces.grant,
      revoke: vi.fn(),
    }),
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
vi.mock("../chat-messages.js", () => ({
  ChatMessages: () => (
    <div data-testid="host-story">Public narrative and required forms</div>
  ),
}));
vi.mock("../game-view/message-composer.js", () => ({
  MessageComposer: () => <textarea aria-label="Host composer" />,
}));
vi.mock("../stage/StageView.js", () => ({
  StageView: ({
    onToggleImmersive,
    composerReplaced,
  }: ComponentProps<typeof StageView>) => (
    <div data-testid="stage-story">
      Stage narrative
      <button onClick={onToggleImmersive}>Toggle immersive stage</button>
      {!composerReplaced && <textarea aria-label="Stage composer" />}
    </div>
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

vi.mock("../plugin-view-host.js", () => ({
  PluginViewHost: (props: ComponentProps<typeof PluginViewHost>) => (
    <section aria-label={props.entry.label}>
      <span>{props.entry.label}</span>
      <textarea aria-label={`Draft ${props.entry.label}`} />
      {!props.entry.spec.webview && props.liveSession?.renderComposer()}
      <button onClick={() => props.onFallback("render-error")}>
        Fail {props.entry.label}
      </button>
      <button onClick={() => props.onFallback()}>
        Return {props.entry.label}
      </button>
    </section>
  ),
}));
const main: PluginViewEntry = {
  ...viewEntry,
  label: "Story page",
  spec: { ...viewEntry.spec, surface: "main" },
};
const input: PluginViewEntry = {
  ...viewEntry,
  pluginId: "other",
  mode: "plugin:other:input",
  viewId: "input",
  label: "Input page",
  spec: { ...viewEntry.spec, id: "input", surface: "composer" },
};
let state: SessionState;
function mount() {
  const tree = () => (
    <SessionStateContext.Provider value={state}>
      <GameView session={state.session!} />
    </SessionStateContext.Provider>
  );
  const view = render(tree());
  return { ...view, update: () => view.rerender(tree()) };
}
function chooseMain() {
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.pluginViews") }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Story page/ }));
}
function chooseInput() {
  fireEvent.change(
    screen.getByRole("combobox", { name: i18n.t("session.surfaceComposer") }),
    { target: { value: input.mode } },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  surfaces.views = [main];
  surfaces.composers = [input];
  surfaces.allowed = true;
  surfaces.denied.clear();
  surfaces.narrow = false;
  surfaces.realDiscovery = false;
  surfaces.reload.mockResolvedValue();
  surfaces.grant.mockResolvedValue();
  state = { ...initialState, session, executing: false };
});
afterEach(cleanup);

it("retains host input beneath an explicit main surface, while an ordinary view keeps its existing layout", () => {
  const view = mount();
  chooseMain();
  expect(screen.getByRole("region", { name: "Story page" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Host composer" })).toBeTruthy();
  surfaces.views = [{ ...main, spec: { ...main.spec, surface: undefined } }];
  view.update();
  expect(screen.queryByRole("textbox", { name: "Host composer" })).toBeNull();
  chooseInput();
  expect(screen.getAllByTestId("sandbox-composer")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "Story page" })).toBeTruthy();
});
it("replaces a declarative view's composer once and restores its input when the sandbox composer returns", () => {
  const desk: PluginViewEntry = {
    ...main,
    spec: {
      id: "desk",
      label: "Story page",
      alwaysRender: true,
      view: { component: "SessionComposer" },
    },
  };
  surfaces.views = [desk];
  mount();
  chooseMain();
  expect(
    screen.getAllByRole("textbox", { name: "Host composer" }),
  ).toHaveLength(1);
  chooseInput();
  expect(screen.getByRole("region", { name: "Story page" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Host composer" })).toBeNull();
  expect(screen.getAllByTestId("sandbox-composer")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Return Input page" }));
  expect(screen.queryByTestId("sandbox-composer")).toBeNull();
  expect(screen.getByRole("region", { name: "Story page" })).toBeTruthy();
  expect(
    screen.getAllByRole("textbox", { name: "Host composer" }),
  ).toHaveLength(1);
});
it.each([false, true])(
  "composes independent providers at narrow width %s and returns both globally",
  (narrow) => {
    surfaces.narrow = narrow;
    mount();
    chooseInput();
    expect(screen.getByTestId("host-story")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Host composer" })).toBeNull();
    chooseMain();
    expect(screen.getByRole("region", { name: "Story page" })).toBeTruthy();
    expect(screen.getAllByRole("region", { name: "Input page" })).toHaveLength(
      1,
    );
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("session.surfaceReturn") }),
    );
    expect(screen.getByTestId("host-story")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Host composer" })).toBeTruthy();
    expect(screen.queryByTestId("sandbox-composer")).toBeNull();
  },
);
it("restores only a failed region and keeps it retired until an explicit refetch and retry", async () => {
  const view = mount();
  chooseMain();
  chooseInput();
  fireEvent.click(screen.getByRole("button", { name: "Fail Input page" }));
  expect(screen.getByRole("region", { name: "Story page" })).toBeTruthy();
  expect(screen.queryByTestId("sandbox-composer")).toBeNull();
  view.update();
  expect(screen.queryByTestId("sandbox-composer")).toBeNull();
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("session.pageRetry") }),
    ),
  );
  expect(surfaces.reload).toHaveBeenCalledOnce();
  expect(screen.getByRole("region", { name: "Input page" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Fail Story page" }));
  expect(screen.getByTestId("host-story")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Input page" })).toBeTruthy();
});
it("keeps the selected composer and protected Stop/return controls in immersive stage during execution", () => {
  state = { ...state, executing: true };
  mount();
  chooseInput();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.viewStageAria") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Toggle immersive stage" }),
  );
  expect(screen.getByTestId("stage-story")).toBeTruthy();
  expect(screen.getAllByTestId("sandbox-composer")).toHaveLength(1);
  expect(screen.queryByRole("textbox", { name: "Stage composer" })).toBeNull();
  const controls = screen.getByTestId("sandbox-surface-controls");
  expect(controls.hasAttribute("data-covel-host-controls")).toBe(true);
  fireEvent.click(
    within(controls).getByRole("button", {
      name: i18n.t("session.surfaceStop"),
    }),
  );
  expect(actions.abortActiveTurn).toHaveBeenCalledOnce();
  fireEvent.click(
    within(controls).getByRole("button", {
      name: i18n.t("session.surfaceReturn"),
    }),
  );
  expect(screen.getByTestId("host-story")).toBeTruthy();
});
it("keeps host story and setup recovery visible while a composer waits for consent", () => {
  surfaces.allowed = false;
  state = { ...state, session: { ...session, phase: "setup" } };
  mount();
  chooseInput();
  expect(screen.queryByTestId("sandbox-composer")).toBeNull();
  expect(screen.getByTestId("host-story")).toBeTruthy();
  expect(screen.getByLabelText("Host composer")).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
});
it("retires a disabled composer without resetting main, and session navigation discards both choices", () => {
  const view = mount();
  chooseMain();
  chooseInput();
  surfaces.composers = [];
  view.update();
  expect(screen.getByRole("region", { name: "Story page" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Host composer" })).toBeTruthy();
  state = { ...state, session: { ...session, id: "next" } };
  view.update();
  expect(screen.queryByRole("region", { name: "Story page" })).toBeNull();
});

it.each(["main", "composer"] as const)(
  "retires only the disabled %s provider during deferred discovery",
  async (region) => {
    const { sessionPlugin } = await import("./plugin-view-fixtures.js");
    surfaces.realDiscovery = true;
    const response: UISpecsResponse = {
      theme: [],
      right: [],
      view: [main, input].map((entry) => ({
        pluginId: entry.pluginId,
        specs: [{ ...entry.spec, label: entry.label }],
      })),
    };
    surfaces.fetch.mockResolvedValueOnce(response);
    state = {
      ...state,
      sessionPlugins: [sessionPlugin, { ...sessionPlugin, id: input.pluginId }],
    };
    const view = mount();
    await screen.findByRole("button", { name: i18n.t("session.pluginViews") });
    chooseMain();
    chooseInput();
    const removed = region === "main" ? main : input;
    const healthy = region === "main" ? input : main;
    const mounted = screen.getByRole("region", { name: healthy.label });
    const draft = within(mounted).getByRole("textbox");
    fireEvent.change(draft, {
      target: { value: "Keep the healthy page draft" },
    });
    let resolve!: (value: typeof response) => void;
    surfaces.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    state = {
      ...state,
      sessionPlugins: state.sessionPlugins.map((plugin) =>
        plugin.id === removed.pluginId ? { ...plugin, active: false } : plugin,
      ),
    };
    view.update();
    expect(screen.queryByRole("region", { name: removed.label })).toBeNull();
    expect(screen.getByRole("region", { name: healthy.label })).toBe(mounted);
    expect((draft as HTMLTextAreaElement).value).toBe(
      "Keep the healthy page draft",
    );
    await act(async () =>
      resolve({
        ...response,
        view: response.view?.filter(
          (entry) => entry.pluginId !== removed.pluginId,
        ),
      }),
    );
    expect(screen.getByRole("region", { name: healthy.label })).toBe(mounted);
    expect((draft as HTMLTextAreaElement).value).toBe(
      "Keep the healthy page draft",
    );
    surfaces.fetch.mockResolvedValueOnce(response);
    state = {
      ...state,
      sessionPlugins: state.sessionPlugins.map((plugin) => ({
        ...plugin,
        active: true,
      })),
    };
    view.update();
    await waitFor(() => expect(surfaces.fetch).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("region", { name: removed.label })).toBeNull();
  },
);
it("does not let a deferred Retry restore a selection after global return or a session round trip", async () => {
  const view = mount();
  chooseMain();
  fireEvent.click(screen.getByRole("button", { name: "Fail Story page" }));
  let finish!: () => void;
  surfaces.reload.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.pageRetry") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.surfaceReturn") }),
  );
  state = { ...state, session: { ...session, id: "next" } };
  view.update();
  state = { ...state, session };
  view.update();
  await act(async () => finish());
  expect(screen.queryByRole("region", { name: "Story page" })).toBeNull();
});

it("keeps a newly selected ungranted main target pending after retiring the previous main", () => {
  const next: PluginViewEntry = {
    ...main,
    mode: "plugin:next:main",
    pluginId: "next",
    label: "Next story",
  };
  surfaces.views = [main, next];
  surfaces.denied.add(next.mode);
  mount();
  chooseMain();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.pluginViews") }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Next story/ }));
  expect(screen.getByRole("dialog").textContent).toContain("Next story");
  expect(screen.queryByRole("region", { name: "Story page" })).toBeNull();
  expect(screen.getByTestId("host-story")).toBeTruthy();
});
it("keeps an ungranted composer target pending and allows switching main to stage", () => {
  const next: PluginViewEntry = {
    ...input,
    mode: "plugin:next:input",
    pluginId: "next",
    label: "Next input",
  };
  surfaces.composers = [input, next];
  surfaces.denied.add(next.mode);
  mount();
  chooseMain();
  chooseInput();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.viewStageAria") }),
  );
  expect(screen.getByTestId("stage-story")).toBeTruthy();
  fireEvent.change(
    screen.getByRole("combobox", { name: i18n.t("session.surfaceComposer") }),
    { target: { value: next.mode } },
  );
  expect(screen.getByRole("dialog").textContent).toContain("Next input");
  expect(screen.queryByTestId("sandbox-composer")).toBeNull();
});

it("keeps a global return inside the consent dialog while a different surface is still active", () => {
  surfaces.denied.add(input.mode);
  mount();
  chooseMain();
  chooseInput();
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Input page");
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: i18n.t("session.surfaceReturn"),
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("region", { name: "Story page" })).toBeNull();
  expect(screen.getByTestId("host-story")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Host composer" })).toBeTruthy();
});

it("does not reuse a pending consent save after return and reselecting the same page", async () => {
  surfaces.denied.add(input.mode);
  let finish!: () => void;
  let current!: () => boolean;
  surfaces.grant.mockImplementationOnce(async (_entry, isCurrent) => {
    current = isCurrent;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  mount();
  chooseInput();
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: i18n.t("session.viewConsentAllow"),
    }),
  );
  expect(current()).toBe(true);
  const back = within(screen.getByRole("dialog")).getByRole("button", {
    name: i18n.t("session.surfaceReturn"),
  });
  expect(back.hasAttribute("disabled")).toBe(false);
  fireEvent.click(back);
  chooseInput();
  expect(current()).toBe(false);
  await act(async () => finish());
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByTestId("sandbox-composer")).toBeNull();
});

it("keeps the session view menu above the protected surface strip", () => {
  mount();
  const header = screen.getByTestId("session-header");
  const strip = screen.getByTestId("sandbox-surface-controls");
  expect(Number(getComputedStyle(strip).zIndex)).toBeGreaterThan(0);
  expect(Number(getComputedStyle(header).zIndex)).toBeGreaterThan(
    Number(getComputedStyle(strip).zIndex),
  );
  fireEvent.click(
    within(header).getByRole("button", { name: i18n.t("session.pluginViews") }),
  );
  expect(
    within(header).getByRole("button", { name: /Story page/ }),
  ).toBeTruthy();
});
