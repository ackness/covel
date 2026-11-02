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

const stageSlots = vi.hoisted(() => ({
  renders: vi.fn(),
  realSprites: false,
  reduce: true,
  items: [] as Array<{ slot: string; value: unknown }>,
}));

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
    expect(screen.getByText("First.")).toBeDefined();
    expect(screen.getByText("Second.")).toBeDefined();
    const input = screen.getByTestId(
      "stage-decision-input",
    ) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "Continue immediately" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSendMessage).toHaveBeenCalledWith("Continue immediately");
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
