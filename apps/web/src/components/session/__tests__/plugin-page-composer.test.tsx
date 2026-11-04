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
import type { PluginViewEntry } from "../game-view/use-plugin-views.js";
import { viewEntry } from "./plugin-view-fixtures.js";
import type { SessionRecord } from "@/services/api.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import type { SessionState } from "@/stores/session-store/types.js";
import { GameView } from "../game-view.js";
import type { PluginViewHost } from "../plugin-view-host.js";
import type { StageView } from "../stage/StageView.js";

const surfaces = vi.hoisted(() => ({
  views: [] as PluginViewEntry[],
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
  ResizablePanel: ({
    children,
    id,
    className,
    style,
  }: ComponentProps<"div">) => (
    <div id={id} className={className} style={style}>
      {children}
    </div>
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
  StageView: ({ onToggleImmersive }: ComponentProps<typeof StageView>) => (
    <div data-testid="stage-story">
      Stage narrative
      <button onClick={onToggleImmersive}>Toggle immersive stage</button>
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
const page: PluginViewEntry = {
  ...viewEntry,
  label: "Story page",
  spec: { ...viewEntry.spec },
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
const header = () => screen.getByTestId("session-header");
function openPage() {
  fireEvent.click(
    within(header()).getByRole("button", {
      name: i18n.t("session.pluginPages"),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Story page/ }));
}
const hostComposer = () =>
  screen.queryAllByRole("textbox", {
    name: "Host composer",
  });
beforeEach(() => {
  vi.clearAllMocks();
  surfaces.views = [page];
  surfaces.allowed = true;
  surfaces.denied.clear();
  surfaces.narrow = false;
  surfaces.realDiscovery = false;
  surfaces.reload.mockResolvedValue();
  surfaces.grant.mockResolvedValue();
  state = { ...initialState, session, executing: false };
});
afterEach(cleanup);

it("keeps the host input box under a plugin page and renders no control strip", () => {
  mount();
  expect(screen.queryByTestId("sandbox-surface-controls")).toBeNull();
  openPage();
  expect(screen.getByRole("region", { name: "Story page" })).toBeTruthy();
  expect(hostComposer()).toHaveLength(1);
  expect(screen.queryByTestId("sandbox-surface-controls")).toBeNull();
  expect(screen.queryByTestId("host-story")).toBeNull();
});
it("hides the host input box for composer: false and leaves Stop in the header while a turn runs", () => {
  surfaces.views = [{ ...page, spec: { ...page.spec, composer: false } }];
  state = { ...initialState, session, executing: true };
  mount();
  openPage();
  expect(hostComposer()).toHaveLength(0);
  fireEvent.click(
    within(header()).getByRole("button", { name: i18n.t("session.stopTurn") }),
  );
  expect(actions.abortActiveTurn).toHaveBeenCalledOnce();
});
it("keeps Stop out of the header while the host input box is visible", () => {
  state = { ...initialState, session, executing: true };
  mount();
  openPage();
  expect(
    within(header()).queryByRole("button", {
      name: i18n.t("session.stopTurn"),
    }),
  ).toBeNull();
});
it("shows one input when the page embeds its own SessionComposer", () => {
  surfaces.views = [
    {
      ...page,
      spec: {
        id: "desk",
        label: "Story page",
        alwaysRender: true,
        view: {
          component: "Stack",
          children: [{ component: "SessionComposer" }],
        },
      },
    },
  ];
  mount();
  openPage();
  expect(hostComposer()).toHaveLength(1);
});
it("leaves a plugin page through the Text and Stage toggle", () => {
  mount();
  openPage();
  expect(screen.getByRole("region", { name: "Story page" })).toBeTruthy();
  fireEvent.click(
    within(header()).getByRole("button", {
      name: i18n.t("session.viewParsedAria"),
    }),
  );
  expect(screen.queryByRole("region", { name: "Story page" })).toBeNull();
  expect(screen.getByTestId("host-story")).toBeTruthy();
});
it("falls back to the read view when a page fails to render", () => {
  mount();
  openPage();
  fireEvent.click(screen.getByRole("button", { name: "Fail Story page" }));
  expect(screen.queryByRole("region", { name: "Story page" })).toBeNull();
  expect(screen.getByTestId("host-story")).toBeTruthy();
  expect(hostComposer()).toHaveLength(1);
});
