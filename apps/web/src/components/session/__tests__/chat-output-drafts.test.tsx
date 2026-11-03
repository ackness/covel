import { createRef } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { ChatMessages, type ChatMessagesProps } from "../chat-messages.js";
import {
  SessionActionsContext,
  SessionStateContext,
  type SessionActions,
} from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import type { OutputDraft } from "@/stores/session-store/output-drafts.js";

const settings = vi.hoisted(() => ({ liveOutput: "units" as string }));
vi.mock("@/settings/use-settings.js", () => ({
  useSetting: (key: string) => [
    key === "ui.liveOutput" ? settings.liveOutput : false,
  ],
}));
vi.mock("@/theme-system/use-theme-layout.js", () => ({
  useThemeLayout: () => ({ turnNotes: "inline", backdrop: "none" }),
}));
vi.mock("@/hooks/use-auto-scroll.js", () => ({
  useAutoScroll: () => ({
    scrollRef: () => {},
    showJumpButton: false,
    jumpToBottom: () => {},
  }),
}));
vi.mock("@/hooks/use-choice-hotkeys.js", () => ({
  useChoiceHotkeys: () => {},
}));
vi.mock("../chat-messages/use-load-older-messages.js", () => ({
  useLoadOlderMessages: () => ({}),
}));
beforeAll(() => i18n.changeLanguage("en-US"));
afterEach(() => {
  cleanup();
  settings.liveOutput = "units";
});

const draft: OutputDraft = {
  turnId: "turn-1",
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

function show(outputDrafts: readonly OutputDraft[]) {
  const props: ChatMessagesProps = {
    messages: [
      {
        id: "say",
        role: "user",
        content: "Follow Aya",
        timestamp: "now",
        turnId: "turn-1",
      },
    ],
    executionSteps: [],
    showExecutionTimeline: false,
    executionError: null,
    executing: true,
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
  return render(
    <SessionActionsContext.Provider value={actions}>
      <SessionStateContext.Provider value={{ ...initialState, outputDrafts }}>
        <ChatMessages {...props} />
      </SessionStateContext.Provider>
    </SessionActionsContext.Provider>,
  );
}

it("shows finished lines with their speakers under the turn while it is written", () => {
  show([draft]);
  const row = screen.getByTestId("output-draft");
  expect(row.closest("[data-turn-id]")?.getAttribute("data-turn-id")).toBe(
    "turn-1",
  );
  expect(row.getAttribute("data-draft-state")).toBe("writing");
  expect(row.textContent).toContain("The rain stopped.");
  expect(row.textContent).toContain("“Let's go.”");
  // Dialogue without a template still names its speaker.
  expect(
    within(row)
      .getAllByTestId("segment-speaker")
      .map((name) => name.textContent),
  ).toEqual(["Aya"]);
  // The line being written waits for its end at the default preference.
  expect(row.textContent).not.toContain("“Wai");
  expect(within(row).getByRole("status").textContent).toBe("Writing…");
});

it("shows the line being written to a player who asked for it", () => {
  settings.liveOutput = "text";
  show([draft]);
  expect(screen.getByTestId("output-draft").textContent).toContain("“Wai");
});

it("shows nothing before the commit to a player who waits for it", () => {
  settings.liveOutput = "committed";
  show([draft, { ...draft, runtimeId: "chorus", units: [], revising: true }]);
  expect(screen.queryByTestId("output-draft")).toBeNull();
  expect(document.querySelectorAll('[data-row-kind="draft"]')).toHaveLength(0);
});

it("keeps a revised draft's place with a note", () => {
  show([{ ...draft, units: [], revising: true }]);
  const row = screen.getByTestId("output-draft");
  expect(row.getAttribute("data-draft-state")).toBe("revising");
  expect(row.textContent).toBe("Revising…");
});
