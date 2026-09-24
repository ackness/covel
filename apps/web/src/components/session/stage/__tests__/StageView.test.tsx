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
} from "@/stores/streaming-text-store.js";
import type { StreamMessage } from "@/stores/session-store.js";
import { StageView, type StageViewProps } from "../StageView.js";

vi.mock("@/hooks/use-media-query.js", () => ({ useMediaQuery: () => true }));
vi.mock("../../chat-messages.js", () => ({ ChatMessages: () => null }));
vi.mock("../../chat-messages/message-blocks.js", () => ({
  MessageBlockRenderer: () => null,
}));
vi.mock("../StageBackdrop.js", () => ({ StageBackdrop: () => null }));
vi.mock("../StageSprites.js", () => ({ StageSprites: () => null }));
vi.mock("../StagePluginPanels.js", () => ({
  StagePluginPanels: () => <div data-testid="plugin-extension" />,
}));
vi.mock("../use-stage-data.js", () => ({
  useStageData: () => ({}),
  useStageNamespace: () => ({}),
}));

afterEach(() => {
  cleanup();
  clearAllStreamingText();
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

    const nextStory = "You enter the library.\n\nThe librarian looks up.";
    act(() => {
      appendStreamingText(stream.id, nextStory);
    });
    expect(screen.getByTestId("stage-dialog")).toBeDefined();
    expect(screen.queryByTestId("stage-choices")).toBeNull();
    expect(screen.queryByTestId("stage-thinking")).toBeNull();

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
