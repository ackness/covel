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
async function setup(pack = themeFixture()) {
  const { store } = await themeStore();
  current.store = store;
  source = await openTheme(store, "session-one", pack);
  await source.select(choiceOf(pack));
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

function expectHostNotice() {
  const notice = screen.getByTestId("story-operation-failure-notice");
  expect(notice.hasAttribute("data-covel-host-controls")).toBe(true);
  expect(notice.closest("[data-covel-theme-part]")).toBeNull();
  expect(notice.closest("[data-covel-theme-scope]")).toBeNull();
  const style = document.querySelector<HTMLStyleElement>(
    "style[data-plugin-theme-style]",
  );
  if (style) {
    const rules = Array.from(style.sheet?.cssRules ?? []);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const selector = (rule as CSSStyleRule).selectorText;
      // No plugin rule may reach the footer, its ancestors or its children.
      expect(notice.closest(selector)).toBeNull();
      expect(notice.querySelector(selector)).toBeNull();
    }
  }
}

it.each(["parsed", "detailed"] as const)(
  "keeps the operation footer host-owned in %s when a theme makes story colors indistinguishable",
  async (viewMode) => {
    const palette = {
      "--story-color": "#ffffff",
      "--color-background": "#ffffff",
      "--color-muted-foreground": "#ffffff",
      "--surface-story": "#ffffff",
    };
    const theme = await setup({
      ...themeFixture(),
      tokens: { light: palette, dark: palette },
    });
    const view = render(
      <ChatMessageRenderer
        {...props}
        viewMode={viewMode}
        msg={{ ...props.msg, operationFailures: { count: 1 } }}
      />,
    );
    expect(
      view.container.querySelector("[data-covel-theme-part]"),
    ).not.toBeNull();
    expectHostNotice();
    const notice = screen.getByTestId("story-operation-failure-notice");
    const before = notice.outerHTML;
    await act(async () => theme.select(null));
    expectHostNotice();
    expect(notice.outerHTML).toBe(before);
    await act(async () => theme.select(choiceOf(themeFixture())));
    expectHostNotice();
    expect(notice.outerHTML).toBe(before);
  },
);
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
        message={{
          id: "story",
          content: "First paragraph.\n\nNext paragraph.",
          segments: [
            { kind: "narration", text: "First paragraph." },
            { kind: "narration", text: "Next paragraph." },
          ],
        }}

        autoPlay={false}
        reducedMotion
      />
    </>,
  );
  const prose = screen.getByText(/First paragraph/);
  expect(
    prose
      .closest("[data-covel-theme-part]")
      ?.getAttribute("data-covel-theme-part"),
  ).toBe("dialogue");
  const advance = screen.getByRole("button", { name: "下一段" });
  expect(advance.closest("[data-covel-theme-part]")).toBeNull();
  expect(advance.querySelector("[data-covel-theme-part]")).toBeNull();
  fireEvent.click(advance);
  expect(
    screen
      .getByText("Next paragraph.")
      .closest("[data-covel-theme-part]")
      ?.getAttribute("data-covel-theme-part"),
  ).toBe("dialogue");
  await act(async () => theme.select(null));
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
      messages: [
        {
          ...props.msg,
          content: "Current narration.",
          operationFailures: { count: 1 },
        },
      ],
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
        <StageView {...stageProps} immersive={immersive} />
      </>
    );
    const view = render(stage(false));
    expectHostNotice();
    expect(screen.getByTestId("stage-choices")).toBeDefined();
    expect(
      (screen.getByTestId("stage-decision-input") as HTMLTextAreaElement)
        .disabled,
    ).toBe(false);
    const reader = screen.getByTestId("stage-dialog").querySelector("article");
    const dialogue =
      screen
        .getByTestId("stage-dialog")
        .querySelector("[data-covel-theme-part=dialogue]") ??
      screen.getByTestId("stage-dialog").querySelector("p,span");
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
    expectHostNotice();
    expect(
      screen
        .getByTestId("stage-dialog")
        .querySelector("[data-covel-theme-part=dialogue]") ??
        screen.getByTestId("stage-dialog").querySelector("p,span"),
    ).toBe(dialogue);
    const advance = screen.getByTestId("stage-decision-input");
    expect(advance.closest("[data-covel-theme-part]")).toBeNull();
    if (selected) {
      await act(async () => theme.select(null));
      expectHostNotice();
      expect(document.querySelector("[data-covel-theme-part]")).toBeNull();
      expect(
        document.querySelector("style[data-plugin-theme-style]"),
      ).toBeNull();
      expect(screen.getByTestId("stage-dialog").querySelector("article")).toBe(
        reader,
      );
      expect(screen.getByText("Current narration.")).toBeDefined();
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
