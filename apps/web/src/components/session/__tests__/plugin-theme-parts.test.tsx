import type { TFunction } from "i18next";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SettingsStoreApi } from "@covel/settings";
import { JSONUIProvider, Renderer } from "@json-render/react";
import i18n from "@/i18n/index.js";
import { covelRegistry } from "@/lib/catalog.js";
import { pluginPanelViewToSpec } from "@/lib/plugin-panel-spec.js";
import { ChatMessageRenderer } from "../chat-messages/chat-message-renderer.js";
import { StageDialog } from "../stage/StageDialog.js";
import { StageView, type StageViewProps } from "../stage/StageView.js";
import { SessionRecoveryControls } from "../session-recovery-controls.js";
import {
  themeStore,
  openTheme,
  themeFixture,
  choiceOf,
} from "@/theme-system/__tests__/plugin-theme-fixture.js";
import type { PluginThemeSession } from "@/theme-system/plugin-themes.js";
const current = vi.hoisted(() => ({
  store: undefined as unknown as SettingsStoreApi,
}));
vi.mock("@/settings/store.js", () => ({ getSettings: () => current.store }));
vi.mock("react-force-graph-2d", () => ({ default: () => null }));
let source: PluginThemeSession | undefined;
afterEach(() => {
  cleanup();
  source?.dispose();
  vi.unstubAllGlobals();
});
async function setup() {
  const { store } = await themeStore();
  current.store = store;
  source = await openTheme(store);
  await source.select(choiceOf(themeFixture()));
  return source;
}
const t = i18n.t.bind(i18n) as TFunction;
const props = {
  msg: {
    id: "public-story",
    role: "assistant" as const,
    kind: "story" as const,
    content:
      "# Public story\n\nA **readable** line.\n\n![Held image](https://example.invalid/test.png)",
    timestamp: "2026-01-01",
  },
  viewMode: "parsed" as const,
  isImageGenActive: true,
  sessionId: "session-one",
  executing: false,
  generatingImage: false,
  onGenerateImage: vi.fn(),
  t,
};
it.each([false, true])(
  "preserves paragraph spacing and the default markup with theme selected: %s",
  async (selected) => {
    const { store } = await themeStore();
    current.store = store;
    source = await openTheme(store);
    if (selected) await source.select(choiceOf(themeFixture()));
    const view = render(
      <ChatMessageRenderer
        {...props}
        msg={{
          ...props.msg,
          content: "First **readable** paragraph.\n\nSecond paragraph.",
        }}
      />,
    );
    await screen.findByText("readable");
    const paragraphs = view.container.querySelectorAll(".ui-narrative p");
    expect(paragraphs).toHaveLength(2);
    const second = paragraphs[1]!;
    // narrative.css gives adjacent paragraphs their 1.25rem margin. An extra
    // element between them breaks that rule; jsdom does not measure layout.
    expect(second.matches(".ui-narrative.prose p + p")).toBe(true);
    if (selected) {
      expect(
        second.querySelector("[data-covel-theme-part=story]"),
      ).not.toBeNull();
      await act(async () => source?.select(null));
    }
    expect(second.innerHTML).toBe("Second paragraph.");
    expect(view.container.querySelector("[data-covel-theme-part]")).toBeNull();
  },
);
it("marks only story text leaves, keeping markdown image consent and generation controls outside palette ancestors", async () => {
  await setup();
  const view = render(<ChatMessageRenderer {...props} />);
  await screen.findByText("readable");
  await waitFor(() =>
    expect(
      view.container.querySelector("h1 [data-covel-theme-part=story]"),
    ).not.toBeNull(),
  );
  expect(
    screen.getByText("readable").closest('[data-covel-theme-part="story"]'),
  ).not.toBeNull();
  const buttons = screen.getAllByRole("button");
  expect(buttons.length).toBeGreaterThanOrEqual(2);
  for (const button of buttons) {
    expect(button.closest("[data-covel-theme-part]")).toBeNull();
    expect(button.querySelector("[data-covel-theme-part]")).toBeNull();
  }
  expect(
    view.container
      .querySelector(".ui-message-row")
      ?.hasAttribute("data-covel-theme-scope"),
  ).toBe(false);
  for (const update of [
    { ...props, viewMode: "raw" as const },
    {
      ...props,
      viewMode: "detailed" as const,
      msg: { ...props.msg, role: "system" as const },
    },
    {
      ...props,
      viewMode: "detailed" as const,
      msg: { ...props.msg, kind: "debug" as const },
    },
    { ...props, msg: { ...props.msg, role: "user" as const } },
  ]) {
    view.rerender(<ChatMessageRenderer {...update} />);
    expect(view.container.querySelector("[data-covel-theme-part]")).toBeNull();
  }
});
it("keeps stage narration and its sibling advance control separate and retains host recovery without the header", async () => {
  const theme = await setup();
  render(
    <>
      <StageDialog
        sessionId="session-one"
        storyText={"First paragraph.\n\nNext paragraph."}
        streamEnded
        autoPlay={false}
        reducedMotion
        onAllRead={() => {}}
      />
      <SessionRecoveryControls theme={theme} />
    </>,
  );
  const prose = screen.getByText(/First paragraph/);
  expect(prose.getAttribute("data-covel-theme-part")).toBe("dialogue");
  const advance = screen.getByRole("button", { name: "点击继续对话" });
  expect(advance.closest("[data-covel-theme-part]")).toBeNull();
  expect(advance.querySelector("[data-covel-theme-part]")).toBeNull();
  fireEvent.click(advance);
  expect(
    screen.getByText("Next paragraph.").getAttribute("data-covel-theme-part"),
  ).toBe("dialogue");
  const reset = screen.getByRole("button", { name: "使用默认外观" });
  expect(reset.closest("[data-covel-theme-part]")).toBeNull();
  await act(async () => fireEvent.click(reset));
  expect(document.querySelector("[data-covel-theme-part]")).toBeNull();
});
it.each([false, true])(
  "shows the current story on explicit stage entry with a selected theme: %s",
  async (selected) => {
    vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    const theme = await setup();
    if (!selected) await theme.select(null);
    const stageProps = {
      session: {
        id: "session-one",
        worldId: "world",
        status: "active",
        phase: "playing",
        locale: "en-US",
        autoAdvanceLimit: 0,
        completedPlayerTurns: 1,
        setupRuntimes: {},
        seats: [
          {
            id: "human",
            role: "host",
            controller: "human",
            characters: "auto",
          },
        ],
        activePlugins: [],
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
      world: null,
      messages: [{ ...props.msg, content: "Current narration." }],
      executing: false,
      executionError: null,
      executionSteps: [],
      plugins: [],
      sessionPlugins: [],
      submittedBlockIds: new Set<string>(),
      submittedBlockValues: {},
      panelState: { rightSpecs: [], specsStatus: "ready", retrySpecs: vi.fn() },
      onSendMessage: vi.fn(),
      onSubmitBlock: vi.fn(),
      onBeginAdventure: vi.fn(),
      onViewModeChange: vi.fn(),
      immersive: false,
      onToggleImmersive: vi.fn(),
      messagesEndRef: { current: null },
    } satisfies StageViewProps;
    const stage = (immersive: boolean) => (
      <>
        <StageView {...stageProps} immersive={immersive} replayStoryOnEnter />
        <SessionRecoveryControls theme={theme} />
      </>
    );
    const view = render(stage(false));
    expect(screen.getByTestId("stage-choices")).toBeDefined();
    expect(
      (screen.getByTestId("stage-decision-input") as HTMLTextAreaElement)
        .disabled,
    ).toBe(false);
    const dialogue = screen.getByTestId("stage-dialog").querySelector("p");
    expect(dialogue).not.toBeNull();
    expect(dialogue?.textContent).toContain("Current narration.");
    expect(dialogue?.getAttribute("data-covel-theme-part")).toBe(
      selected ? "dialogue" : null,
    );
    if (selected)
      expect(dialogue?.getAttribute("data-covel-theme-scope")).toBe(
        theme.scope,
      );
    view.rerender(stage(true));
    expect(screen.getByTestId("stage-dialog").querySelector("p")).toBe(
      dialogue,
    );
    const advance = screen.getByRole("button", { name: "点击继续对话" });
    expect(advance.closest("[data-covel-theme-part]")).toBeNull();
    if (selected) {
      const reset = screen.getByRole("button", { name: "使用默认外观" });
      expect(reset.closest("[data-covel-theme-part]")).toBeNull();
      await act(async () => fireEvent.click(reset));
      expect(document.querySelector("[data-covel-theme-part]")).toBeNull();
      expect(
        document.querySelector("style[data-plugin-theme-style]"),
      ).toBeNull();
      expect(screen.getByTestId("stage-dialog").querySelector("p")).toBe(
        dialogue,
      );
    }
    expect(stageProps.onSendMessage).not.toHaveBeenCalled();
  },
);
it("never forwards reserved markers from declarative component props, including Prose", async () => {
  await setup();
  const spec = pluginPanelViewToSpec({
    component: "Stack",
    props: {
      "data-covel-theme-scope": source!.scope,
      "data-covel-theme-part": "surface",
    },
    children: [
      {
        component: "Prose",
        props: {
          content: "Plugin prose",
          "data-covel-theme-scope": source!.scope,
          "data-covel-theme-part": "story",
        },
      },
    ],
  });
  if (!spec) throw new Error("missing spec");
  const view = render(
    <JSONUIProvider registry={covelRegistry} initialState={{}} handlers={{}}>
      <Renderer spec={spec} registry={covelRegistry} />
    </JSONUIProvider>,
  );
  await screen.findByText("Plugin prose");
  expect(view.container.querySelector("[data-covel-theme-part]")).toBeNull();
});
