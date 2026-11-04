import type { StageChoicesModel } from "@covel/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { StreamMessage } from "@/stores/session-store.js";
import { StageView, type StageViewProps } from "../StageView.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import type { OutputDraft } from "@/stores/session-store/output-drafts.js";

const stageSlots = vi.hoisted(() => ({
  renders: vi.fn(),
  realSprites: false,
  reduce: true,
  items: [] as Array<{ slot: string; value: unknown }>,
}));

const liveOutput = vi.hoisted(() => ({ value: "units" }));
vi.mock("@/settings/use-settings.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/settings/use-settings.js")>();
  return {
    ...actual,
    useSetting: (key: Parameters<typeof actual.useSetting>[0]) =>
      key === "ui.liveOutput"
        ? [liveOutput.value, async () => {}]
        : actual.useSetting(key),
  };
});
vi.mock("@/hooks/use-media-query.js", () => ({
  useMediaQuery: () => stageSlots.reduce,
}));
vi.mock("../../chat-messages.js", () => ({ ChatMessages: () => null }));
vi.mock("../../chat-messages/message-blocks.js", () => ({
  MessageBlockRenderer: () => null,
}));
vi.mock("../StageBackdrop.js", () => ({ StageBackdrop: () => null }));
vi.mock("../StageSprites.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../StageSprites.js")>();
  return {
    StageSprites: (props: Parameters<typeof actual.StageSprites>[0]) => {
      stageSlots.renders();
      return stageSlots.realSprites ? (
        <actual.StageSprites {...props} />
      ) : (
        <div data-testid="stage-speakers">{JSON.stringify(props.speakers)}</div>
      );
    },
  };
});
vi.mock("../StagePluginPanels.js", () => ({
  StagePluginPanels: () => <div data-testid="plugin-extension" />,
}));
vi.mock("@/stores/ui-slot-store.js", () => ({
  useUiSlots: () => stageSlots.items,
}));

afterEach(() => {
  cleanup();
  stageSlots.items = [];
  stageSlots.realSprites = false;
  stageSlots.reduce = true;
  liveOutput.value = "units";
  vi.useRealTimers();
});

const previousStory: StreamMessage = {
  id: "saved-story",
  role: "assistant",
  kind: "story",
  turnId: "previous-turn",
  content: "The guide offers a tour.",
  timestamp: "2026-09-21T00:00:00Z",
};

function fixture(): StageViewProps {
  return {
    panelState: { rightSpecs: [], specsStatus: "ready", retrySpecs: vi.fn() },
    session: {
      id: "stage-test",
      phase: "playing",
    } as StageViewProps["session"],
    world: null,
    messages: [previousStory],
    executing: false,
    executionError: null,
    executionSteps: [],
    plugins: [],
    sessionPlugins: [],
    submittedBlockIds: new Set(),
    submittedBlockValues: {},
    onSendMessage: vi.fn(),
    onSubmitBlock: vi.fn(),
    onBeginAdventure: vi.fn(),
    onViewModeChange: vi.fn(),
    immersive: false,
    onToggleImmersive: vi.fn(),
    messagesEndRef: { current: null },
  };
}

describe("stage decision lifecycle", () => {
  it("keeps choices and free input ready while rereading a story from another view", () => {
    const props = { ...fixture() };
    const { rerender } = render(<StageView {...props} />);
    expect(screen.getByTestId("stage-dialog")).toBeDefined();
    expect(screen.getByTestId("stage-choices")).toBeDefined();
    const input = screen.getByTestId("stage-decision-input");
    expect((input as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.change(input, { target: { value: "Continue the tour" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSendMessage).toHaveBeenCalledWith("Continue the tour");
    rerender(<StageView {...props} executing />);
    expect(screen.getByTestId("stage-dialog")).toBeDefined();
    expect(screen.queryByTestId("stage-choices")).toBeNull();
  });
  it("keeps explicit story review and extensions when the host replaces stage input", () => {
    const props: StageViewProps = {
      ...fixture(),
      composerReplaced: true,
    };
    const { rerender } = render(<StageView {...props} />);
    expect(screen.getByTestId("stage-dialog")).toBeDefined();
    expect(screen.getByTestId("plugin-extension")).toBeDefined();
    expect(screen.queryByTestId("stage-decision-input")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    rerender(<StageView {...props} executing />);
    expect(screen.getByTestId("stage-dialog")).toBeDefined();
    expect(screen.queryByTestId("stage-choices")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it.each([undefined, { choices: [] }, { recap: "", choices: [] }] satisfies (
    StageChoicesModel | undefined
  )[])(
    "keeps optional recap absent while retaining free input: %j",
    (suggestions) => {
      stageSlots.items = suggestions
        ? [{ slot: "stage.choices@1", value: suggestions }]
        : [];
      const props = fixture();
      render(<StageView {...props} />);
      expect(screen.queryByText("当前信息")).toBeNull();
      expect(screen.getByText(previousStory.content)).toBeDefined();
      const input = screen.getByTestId("stage-decision-input");
      fireEvent.change(input, { target: { value: "Look around" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(props.onSendMessage).toHaveBeenCalledWith("Look around");
    },
  );

  it.each(["missing", "invalid"])(
    "discards a real sprite lifecycle for a %s cast slot and mounts recovery fresh",
    (slotState) => {
      vi.useFakeTimers();
      stageSlots.realSprites = true;
      stageSlots.reduce = false;
      const castSlot = (...ids: string[]) => [
        {
          slot: "stage.cast@1",
          value: {
            actors: ids.map((id) => ({ characterId: id, displayName: id })),
            retainWhenEmpty: false,
            exitTransition: "fade",
          },
        },
      ];
      const props = fixture();
      stageSlots.items = castSlot("A", "B");
      const { rerender } = render(<StageView {...props} />);
      expect(document.querySelectorAll(".ui-stage-sprite")).toHaveLength(2);
      stageSlots.items = castSlot("A");
      rerender(<StageView {...props} />);
      expect(
        document.querySelector('[data-character-id="B"][data-phase="exit"]'),
      ).not.toBeNull();
      stageSlots.items =
        slotState === "missing"
          ? []
          : [
              {
                slot: "stage.cast@1",
                value: {
                  actors: [],
                  retainWhenEmpty: true,
                  exitTransition: "invalid",
                },
              },
            ];
      rerender(<StageView {...props} />);
      expect(screen.queryByTestId("stage-sprites")).toBeNull();
      expect(screen.getByTestId("stage-decision-input")).toBeDefined();
      stageSlots.items = castSlot("C");
      rerender(<StageView {...props} />);
      expect(document.querySelectorAll(".ui-stage-sprite")).toHaveLength(1);
      expect(
        document.querySelector('[data-character-id="C"][data-phase="present"]'),
      ).not.toBeNull();
      act(() => vi.advanceTimersByTime(500));
      expect(document.querySelectorAll(".ui-stage-sprite")).toHaveLength(1);
    },
  );

  it("passes explicit cast focus through to the sprite layer", () => {
    stageSlots.items = [
      {
        slot: "stage.cast@1",
        value: {
          actors: [
            { characterId: "first", displayName: "First", active: false },
            { characterId: "second", displayName: "Second", active: true },
          ],
          retainWhenEmpty: true,
        },
      },
    ];
    render(<StageView {...fixture()} />);
    expect(
      JSON.parse(screen.getByTestId("stage-speakers").textContent ?? ""),
    ).toMatchObject([
      { id: "first", active: false },
      { id: "second", active: true },
    ]);
  });

  it("keeps input available as soon as execution finishes without any reading click", () => {
    const props = fixture();
    const view = render(<StageView {...props} executing />);
    expect(screen.getByText(previousStory.content)).toBeDefined();
    expect(screen.queryByTestId("stage-choices")).toBeNull();
    const message = {
      ...previousStory,
      id: "next",
      turnId: "next",
      content: "First.\n\nSecond.",
      segments: [
        { kind: "narration" as const, text: "First." },
        { kind: "narration" as const, text: "Second." },
      ],
    };
    view.rerender(<StageView {...props} messages={[previousStory, message]} />);
    // The new story opens line by line above the live decision panel.
    expect(screen.getByTestId("stage-reader-line").textContent).toBe("First.");
    expect(screen.queryByText("Second.")).toBeNull();
    const input = screen.getByTestId(
      "stage-decision-input",
    ) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "Continue immediately" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSendMessage).toHaveBeenCalledWith("Continue immediately");
  });
  it("pages a new story by line with speakers, progress and show all", () => {
    stageSlots.realSprites = true;
    stageSlots.items = [
      {
        slot: "stage.cast@1",
        value: {
          actors: [
            { characterId: "char-aya", displayName: "阿雅", active: false },
            { characterId: "char-ren", displayName: "蓮", active: true },
          ],
          retainWhenEmpty: false,
          exitTransition: "fade",
        },
      },
    ];
    const props = fixture();
    const view = render(<StageView {...props} />);
    const message = {
      ...previousStory,
      id: "paged",
      turnId: "paged",
      content: "雨停了。\n\n「走吧。」",
      segments: [
        { kind: "narration" as const, text: "雨停了。" },
        {
          kind: "dialogue" as const,
          text: "「走吧。」",
          speaker: "阿雅",
          speakerId: "char-aya",
        },
      ],
    };
    view.rerender(<StageView {...props} messages={[previousStory, message]} />);
    const line = () => screen.getByTestId("stage-reader-line").textContent;
    expect(line()).toBe("雨停了。");
    expect(screen.queryByTestId("stage-reader-speaker")).toBeNull();
    expect(screen.getByTestId("stage-reader-progress").textContent).toBe(
      "1 / 2",
    );

    fireEvent.keyDown(window, { key: " " });
    expect(line()).toBe("「走吧。」");
    expect(screen.getByTestId("stage-reader-speaker").textContent).toBe("阿雅");
    expect(screen.getByTestId("stage-reader-progress").textContent).toBe(
      "2 / 2",
    );
    // The speaking character is highlighted instead of the cast's active one.
    const sprite = (id: string) =>
      document.querySelector(`[data-character-id="${id}"] > div`)?.className;
    expect(sprite("char-aya")).toContain("ui-stage-sprite-active");
    expect(sprite("char-ren")).toContain("ui-stage-sprite-inactive");

    // Typing in the panel never pages the story.
    fireEvent.keyDown(screen.getByTestId("stage-decision-input"), {
      key: "ArrowLeft",
    });
    expect(line()).toBe("「走吧。」");

    fireEvent.click(screen.getByTestId("stage-reader-show-all"));
    expect(screen.queryByTestId("stage-reader")).toBeNull();
    expect(screen.getByText("雨停了。")).toBeDefined();
    expect(screen.getByText("「走吧。」")).toBeDefined();
  });
  it("auto-plays each line for a time that grows with its length", () => {
    vi.useFakeTimers();
    const props = fixture();
    const view = render(<StageView {...props} />);
    view.rerender(
      <StageView
        {...props}
        messages={[
          previousStory,
          {
            ...previousStory,
            id: "auto",
            turnId: "auto",
            content: "Short.\n\nNext.",
            segments: [
              { kind: "narration" as const, text: "Short." },
              { kind: "narration" as const, text: "Next." },
            ],
          },
        ]}
      />,
    );
    const autoPlay = document.querySelector("button[aria-pressed]");
    expect(autoPlay).not.toBeNull();
    fireEvent.click(autoPlay!);
    expect(screen.getByTestId("stage-reader-line").textContent).toBe("Short.");
    act(() => vi.advanceTimersByTime(1799));
    expect(screen.getByTestId("stage-reader-line").textContent).toBe("Short.");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("stage-reader-line").textContent).toBe("Next.");
    act(() => vi.advanceTimersByTime(1800));
    expect(screen.queryByTestId("stage-reader")).toBeNull();
  });
  it("retains resolved speakers and navigation without gating input", () => {
    const props = fixture();
    const text = "雨停了。\n\n「走吧。」";
    render(
      <StageView
        {...props}
        messages={[
          {
            ...previousStory,
            content: text,
            segments: [
              { kind: "narration", text: "雨停了。" },
              {
                kind: "dialogue",
                text: "「走吧。」",
                speaker: "阿雅",
                speakerId: "char-aya",
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByTestId("stage-dialog-speaker").textContent).toBe("阿雅");
    fireEvent.click(screen.getByRole("button", { name: "下一段" }));
    expect(
      document
        .querySelector('[data-stage-paragraph="1"]')
        ?.getAttribute("data-reader-current"),
    ).toBe("true");
    expect(
      (screen.getByTestId("stage-decision-input") as HTMLTextAreaElement)
        .disabled,
    ).toBe(false);
  });
  it("renders restored history immediately whether it arrives before or after mount", () => {
    const props = fixture();
    const view = render(<StageView {...props} messages={[]} executing />);
    view.rerender(<StageView {...props} />);
    expect(screen.getByText(previousStory.content)).toBeDefined();
    expect(screen.getByTestId("stage-choices")).toBeDefined();
    expect(document.querySelector('[data-reveal-hidden="true"]')).toBeNull();
  });
  it("restores the previous decision when an attempt ends without a new story", () => {
    const props = fixture();
    const { rerender } = render(<StageView {...props} />);
    rerender(<StageView {...props} executing />);
    expect(screen.queryByTestId("stage-choices")).toBeNull();
    rerender(<StageView {...props} executionError="Request failed" />);
    expect(screen.getByTestId("stage-decision-input")).toBeDefined();
    expect(screen.getByTestId("stage-dialog")).toBeDefined();
  });
});

it("keeps the current story notice visible after reading without gating input or restarting the dialog", () => {
  const props = {
    ...fixture(),
    messages: [{ ...previousStory, operationFailures: { count: 1 } }],
  };
  const { rerender } = render(<StageView {...props} />);
  expect(
    screen.getByTestId("story-operation-failure-notice").textContent,
  ).toContain("1");
  expect(screen.getByTestId("stage-dialog")).toBeDefined();
  expect(screen.getByTestId("stage-dialog")).toBeDefined();
  expect(screen.getByTestId("story-operation-failure-notice")).toBeDefined();
  const input = screen.getByTestId(
    "stage-decision-input",
  ) as HTMLTextAreaElement;
  expect(input.disabled).toBe(false);
  fireEvent.change(input, { target: { value: "Continue" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(props.onSendMessage).toHaveBeenCalledWith("Continue");
  rerender(
    <StageView
      {...props}
      messages={[{ ...props.messages[0]!, operationFailures: { count: 2 } }]}
    />,
  );
  expect(screen.getByTestId("stage-dialog")).toBeDefined();
  expect(
    screen.getByTestId("story-operation-failure-notice").textContent,
  ).toContain("2");
});

describe("stage story drafts", () => {
  const writing: OutputDraft = {
    turnId: "turn-2",
    runtimeId: "narrator",
    pluginId: "narrator",
    draftId: "a",
    units: [
      { text: "The rain stopped.", meta: { kind: "narration" } },
      { text: "“Let's go.”", meta: { kind: "dialogue", speaker: "Aya" } },
    ],
    partial: { text: "“Wai", meta: { kind: "dialogue", speaker: "Ren" } },
    accepted: false,
    revising: false,
  };
  const committed: StreamMessage = {
    id: "committed-story",
    role: "assistant",
    kind: "story",
    turnId: "turn-2",
    runtimeId: "narrator",
    content: "The rain stopped.\n\n“Let's go.”",
    timestamp: "2026-09-21T00:01:00Z",
    segments: [
      { kind: "narration", text: "The rain stopped." },
      { kind: "dialogue", text: "“Let's go.”", speaker: "Aya" },
    ],
  };
  function stage(
    outputDrafts: readonly OutputDraft[],
    overrides: Partial<StageViewProps> = {},
  ) {
    return (
      <SessionStateContext.Provider value={{ ...initialState, outputDrafts }}>
        <StageView {...fixture()} executing {...overrides} />
      </SessionStateContext.Provider>
    );
  }
  const line = () => screen.getByTestId("stage-reader-line").textContent;

  it("reads a draft line by line while the turn runs and keeps the page when it commits", () => {
    const view = render(stage([writing]));
    const panel = screen.getByTestId("stage-draft-panel");
    expect(panel).toBeDefined();
    expect(line()).toBe("The rain stopped.");
    expect(screen.getByTestId("stage-reader-status")).toBeDefined();
    // The saved story is not shown over the draft.
    expect(screen.queryByText(previousStory.content)).toBeNull();

    fireEvent.click(screen.getByTestId("stage-reader-line"));
    expect(line()).toBe("“Let's go.”");
    expect(screen.getByTestId("stage-reader-speaker").textContent).toBe("Aya");
    // The last line written so far waits for the next one.
    fireEvent.keyDown(window, { key: " " });
    expect(line()).toBe("“Let's go.”");

    view.rerender(stage([{ ...writing, accepted: true, partial: undefined }]));
    expect(line()).toBe("“Let's go.”");
    expect(screen.queryByTestId("stage-reader-status")).toBeNull();

    // The committed story replaces the draft on the same page.
    view.rerender(
      stage([], { messages: [previousStory, committed], executing: false }),
    );
    expect(line()).toBe("“Let's go.”");
    expect(screen.getByTestId("stage-decision-input")).toBeDefined();
    fireEvent.keyDown(window, { key: " " });
    expect(screen.queryByTestId("stage-reader")).toBeNull();
    expect(screen.getByText("The rain stopped.")).toBeDefined();
  });

  it("shows the partial line only to players who read text as it is written", () => {
    liveOutput.value = "text";
    const view = render(stage([writing]));
    fireEvent.keyDown(window, { key: " " });
    fireEvent.keyDown(window, { key: " " });
    expect(line()).toBe("“Wai");
    expect(screen.getByTestId("stage-reader-speaker").textContent).toBe("Ren");
    view.unmount();
  });

  it("shows the next line as soon as it is written when the player asked for it", () => {
    const first = { ...writing, units: writing.units.slice(0, 1) };
    const view = render(stage([first]));
    expect(line()).toBe("The rain stopped.");
    fireEvent.keyDown(window, { key: " " });
    expect(line()).toBe("The rain stopped.");
    view.rerender(stage([writing]));
    expect(line()).toBe("“Let's go.”");
  });

  it("auto-plays up to the last line written and waits there", () => {
    vi.useFakeTimers();
    render(stage([writing]));
    fireEvent.click(document.querySelector("button[aria-pressed]")!);
    act(() => vi.advanceTimersByTime(5000));
    expect(line()).toBe("“Let's go.”");
    act(() => vi.advanceTimersByTime(60_000));
    expect(line()).toBe("“Let's go.”");
  });

  it("starts again at the first line when the model revises", () => {
    const view = render(stage([writing]));
    fireEvent.keyDown(window, { key: " " });
    expect(line()).toBe("“Let's go.”");
    view.rerender(
      stage([{ ...writing, units: [], partial: undefined, revising: true }]),
    );
    expect(screen.queryByTestId("stage-reader-line")).toBeNull();
    expect(screen.getByTestId("stage-reader")).toBeDefined();
    view.rerender(stage([{ ...writing, draftId: "b" }]));
    expect(line()).toBe("The rain stopped.");
  });

  it("shows nothing before the commit to players who wait for it", () => {
    liveOutput.value = "committed";
    render(stage([writing]));
    expect(screen.queryByTestId("stage-draft-panel")).toBeNull();
    expect(screen.queryByTestId("stage-reader")).toBeNull();
    expect(screen.getByText(previousStory.content)).toBeDefined();
  });
});
