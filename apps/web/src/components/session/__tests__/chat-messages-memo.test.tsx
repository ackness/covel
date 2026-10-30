import { createRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatMessages, type ChatMessagesProps } from "../chat-messages.js";
import {
  SessionActionsContext,
  SessionStateContext,
  type SessionActions,
} from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
const mocks = vi.hoisted(() => ({
  group: vi.fn(() => []),
  scroll: vi.fn(),
  generate: vi.fn(),
}));
vi.mock("@/settings/use-settings.js", () => ({ useSetting: () => [false] }));
vi.mock("@/theme-system/use-theme-layout.js", () => ({
  useThemeLayout: () => ({ turnNotes: "inline", backdrop: "none" }),
}));
vi.mock("@/hooks/use-auto-scroll.js", () => ({
  useAutoScroll: () => ({
    scrollRef: mocks.scroll,
    showJumpButton: false,
    jumpToBottom: mocks.scroll,
  }),
}));
vi.mock("@/hooks/use-choice-hotkeys.js", () => ({
  useChoiceHotkeys: () => {},
}));
vi.mock("../chat-messages/use-load-older-messages.js", () => ({
  useLoadOlderMessages: () => ({}),
}));
vi.mock("../chat-messages/use-image-generation.js", () => ({
  useImageGeneration: () => ({
    isImageGenActive: false,
    generatingImage: false,
    handleGenerateImage: mocks.generate,
  }),
}));
vi.mock("../chat-messages/use-message-grouping.js", () => ({
  useMessageGrouping: mocks.group,
}));
afterEach(cleanup);

it("keeps history rendering stable for unchanged props and unrelated session state", () => {
  const props: ChatMessagesProps = {
    messages: [],
    executionSteps: [],
    executionError: null,
    executing: false,
    session: {
      id: "s",
      status: "active",
      phase: "playing",
    } as ChatMessagesProps["session"],
    world: null,
    plugins: [],
    sessionPlugins: [],
    submittedBlockIds: new Set(),
    submittedBlockValues: {},
    viewMode: "parsed",
    onSendMessage: vi.fn(),
    onSubmitBlock: vi.fn(),
    onBeginAdventure: vi.fn(),
    messagesEndRef: createRef(),
  };
  const actions = { loadOlderMessages: vi.fn() } as unknown as SessionActions;
  const view = (state = initialState, input = props) => (
    <SessionActionsContext.Provider value={actions}>
      <SessionStateContext.Provider value={state}>
        <ChatMessages {...input} />
      </SessionStateContext.Provider>
    </SessionActionsContext.Provider>
  );
  const { rerender } = render(view());
  const calls = mocks.group.mock.calls.length;
  rerender(view());
  rerender(view({ ...initialState, initialEventCursor: "epoch:1" }));
  expect(mocks.group).toHaveBeenCalledTimes(calls);
  rerender(
    view(initialState, {
      ...props,
      messages: [
        { id: "new", role: "user", content: "Hello", timestamp: "now" },
      ],
    }),
  );
  expect(mocks.group.mock.calls.length).toBeGreaterThan(calls);
});
