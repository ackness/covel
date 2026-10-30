import type { StageChoicesModel } from "@covel/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  appendStreamingText,
  clearAllStreamingText,
  setStreamingSegment,
} from "@/stores/streaming-text-store.js";
import type { StreamMessage } from "@/stores/session-store.js";
import { StageView, type StageViewProps } from "../StageView.js";

const stageSlots = vi.hoisted(() => ({
  renders: vi.fn(),
  items: [] as Array<{ slot: string; value: unknown }>,
}));

vi.mock("@/hooks/use-media-query.js", () => ({ useMediaQuery: () => true }));
vi.mock("../../chat-messages.js", () => ({ ChatMessages: () => null }));
vi.mock("../../chat-messages/message-blocks.js", () => ({
  MessageBlockRenderer: () => null,
}));
vi.mock("../StageBackdrop.js", () => ({ StageBackdrop: () => null }));
vi.mock("../StageSprites.js", () => ({
  StageSprites: ({ speakers }: { speakers: unknown }) => {
    stageSlots.renders();
    return <div data-testid="stage-speakers">{JSON.stringify(speakers)}</div>;
  },
}));
vi.mock("../StagePluginPanels.js", () => ({
  StagePluginPanels: () => <div data-testid="plugin-extension" />,
}));
vi.mock("@/stores/ui-slot-store.js", () => ({
  useUiSlots: () => stageSlots.items,
}));

afterEach(() => {
  cleanup();
  clearAllStreamingText();
  stageSlots.items = [];
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
      expect(screen.queryByText(previousStory.content)).toBeNull();
      const input = screen.getByTestId("stage-decision-input");
      fireEvent.change(input, { target: { value: "Look around" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(props.onSendMessage).toHaveBeenCalledWith("Look around");
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

  it("hides the old decision and plugin surface until the new story is read and execution finishes", () => {
    let props = fixture();
    const { rerender } = render(<StageView {...props} />);
    expect(screen.getByTestId("stage-choices")).toBeDefined();
    expect(screen.getByTestId("plugin-extension")).toBeDefined();
    fireEvent.change(screen.getByTestId("stage-decision-input"), {
      target: { value: "Visit the library" },
    });
    fireEvent.keyDown(screen.getByTestId("stage-decision-input"), {
      key: "Enter",
    });
    expect(props.onSendMessage).toHaveBeenCalledWith("Visit the library");

    // The request starts before any new story message or token arrives.
    props = { ...props, executing: true };
    rerender(<StageView {...props} />);
    expect(screen.queryByTestId("stage-choices")).toBeNull();
    expect(screen.queryByTestId("plugin-extension")).toBeNull();
    expect(screen.queryByTestId("stage-dialog")).toBeNull();
    expect(screen.getByTestId("stage-thinking")).toBeDefined();

    const stream: StreamMessage = {
      ...previousStory,
      id: "stream_next-turn_narrator",
      turnId: "next-turn",
      content: "",
    };
    props = { ...props, messages: [previousStory, stream] };
    rerender(<StageView {...props} />);
    expect(screen.queryByTestId("stage-choices")).toBeNull();
    expect(screen.queryByTestId("stage-dialog")).toBeNull();
    expect(screen.getByTestId("stage-thinking")).toBeDefined();

    const stageRenders = stageSlots.renders.mock.calls.length;
    const nextStory = "You enter the library.\n\nThe librarian looks up.";
    act(() => {
      appendStreamingText(stream.id, nextStory);
    });
    expect(screen.getByTestId("stage-dialog")).toBeDefined();
    expect(screen.queryByTestId("stage-choices")).toBeNull();
    expect(screen.queryByTestId("stage-thinking")).toBeNull();
    expect(stageSlots.renders).toHaveBeenCalledTimes(stageRenders);

    // Narration commits before the remaining plugins finish.
    props = {
      ...props,
      messages: [
        previousStory,
        { ...stream, id: "next-story", content: nextStory },
      ],
    };
    rerender(<StageView {...props} />);
    // Click through the paragraphs; the last one also waits for a closing
    // click before the dialog hands over to the decision panel.
    fireEvent.click(screen.getByRole("button", { name: "点击继续对话" }));
    fireEvent.click(screen.getByRole("button", { name: "点击继续对话" }));
    expect(screen.queryByTestId("stage-dialog")).toBeNull();
    expect(screen.queryByTestId("stage-choices")).toBeNull();

    props = { ...props, executing: false };
    rerender(<StageView {...props} />);
    expect(screen.getByTestId("stage-choices")).toBeDefined();
    expect(screen.getByTestId("plugin-extension")).toBeDefined();
    expect(screen.queryByTestId("stage-thinking")).toBeNull();
  });

  it("names paragraphs with live speakers while streaming, then the resolved names", () => {
    let props = { ...fixture(), executing: true };
    const stream: StreamMessage = {
      ...previousStory,
      id: "stream_next-turn_narrator",
      turnId: "next-turn",
      content: "",
    };
    props = { ...props, messages: [previousStory, stream] };
    const { rerender } = render(<StageView {...props} />);
    const text = "雨停了。\n\n「走吧。」";
    act(() => {
      setStreamingSegment(stream.id, { index: 0, kind: "narration" });
      appendStreamingText(stream.id, "雨停了。");
    });
    expect(screen.getByTestId("stage-dialog")).toBeDefined();
    expect(screen.queryByTestId("stage-dialog-speaker")).toBeNull();
    // A second paragraph whose metadata has not arrived names nobody, so
    // it never borrows another paragraph's speaker.
    act(() => {
      appendStreamingText(stream.id, "\n\n「走吧。」");
    });
    fireEvent.click(screen.getByRole("button", { name: "点击继续对话" }));
    expect(screen.queryByTestId("stage-dialog-speaker")).toBeNull();
    // Its live speaker is the name as the model wrote it.
    act(() => {
      setStreamingSegment(stream.id, {
        index: 1,
        kind: "dialogue",
        speaker: "小雅",
      });
    });
    expect(screen.getByTestId("stage-dialog-speaker").textContent).toBe("小雅");

    props = {
      ...props,
      messages: [
        previousStory,
        {
          ...stream,
          id: "next-story",
          content: text,
          segments: [
            { kind: "narration", text: "雨停了。" },
            {
              kind: "dialogue",
              speaker: "阿雅",
              speakerId: "char-aya",
              text: "「走吧。」",
            },
          ],
        },
      ],
    };
    rerender(<StageView {...props} />);
    // Commit replaces the written alias with the resolved name.
    expect(screen.getByTestId("stage-dialog-speaker").textContent).toBe("阿雅");
  });

  it("shows the decision when the restored history arrives after Stage mounts", () => {
    const props = fixture();
    const { rerender } = render(<StageView {...props} messages={[]} />);
    expect(screen.queryByTestId("stage-choices")).toBeNull();

    rerender(<StageView {...props} />);
    expect(screen.queryByTestId("stage-dialog")).toBeNull();
    expect(screen.getByTestId("stage-choices")).toBeDefined();
  });

  it("treats a story that arrives while the restore is still checking as history", () => {
    const props = { ...fixture(), executing: true, restoring: true };
    const { rerender } = render(<StageView {...props} messages={[]} />);
    rerender(<StageView {...props} />);
    rerender(<StageView {...props} executing={false} restoring={false} />);
    expect(screen.queryByTestId("stage-dialog")).toBeNull();
    expect(screen.getByTestId("stage-choices")).toBeDefined();
  });

  it("plays the first story of a turn running in this view", () => {
    const props = { ...fixture(), messages: [], executing: true };
    const { rerender } = render(<StageView {...props} />);
    rerender(
      <StageView
        {...props}
        messages={[{ ...previousStory, id: "opening", turnId: "opening" }]}
      />,
    );
    rerender(
      <StageView
        {...props}
        executing={false}
        messages={[{ ...previousStory, id: "opening", turnId: "opening" }]}
      />,
    );
    expect(screen.getByTestId("stage-dialog")).toBeDefined();
    expect(screen.queryByTestId("stage-choices")).toBeNull();
  });

  it("restores the previous decision when an attempt ends without a new story", () => {
    const props = fixture();
    const { rerender } = render(<StageView {...props} />);
    rerender(<StageView {...props} executing />);
    expect(screen.queryByTestId("stage-choices")).toBeNull();
    rerender(<StageView {...props} executionError="Request failed" />);
    expect(screen.getByTestId("stage-decision-input")).toBeDefined();
    expect(screen.queryByTestId("stage-dialog")).toBeNull();
  });
});
