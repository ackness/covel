import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamMessage } from "@/stores/session-store.js";
import type { SessionRecord } from "@/services/api.js";
import { useGameViewComposer } from "../game-view/use-game-view-composer.js";

// Composer availability is the player's core affordance, so it gets a
// deterministic test rather than relying on the live-LLM e2e run.
const sessionMock = {
  pendingInteractionDrafts: [] as Array<Record<string, unknown>>,
  suspensions: [] as unknown[],
  clearInteractionDrafts: vi.fn(),
  removeInteractionDraft: vi.fn(),
  submitBlock: vi.fn(),
  resumeSuspension: vi.fn(),
  cancelSuspension: vi.fn(),
  steerMessage: vi.fn(async () => true),
  abortActiveTurn: vi.fn(async () => {}),
};

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      pendingInteractionDrafts: sessionMock.pendingInteractionDrafts,
      suspensions: sessionMock.suspensions,
    },
    clearInteractionDrafts: sessionMock.clearInteractionDrafts,
    removeInteractionDraft: sessionMock.removeInteractionDraft,
    submitBlock: sessionMock.submitBlock,
    resumeSuspension: sessionMock.resumeSuspension,
    cancelSuspension: sessionMock.cancelSuspension,
    steerMessage: sessionMock.steerMessage,
    abortActiveTurn: sessionMock.abortActiveTurn,
  }),
}));

const message = (block: Record<string, unknown>): StreamMessage => ({
  id: "msg-1",
  role: "assistant",
  content: "",
  timestamp: "2026-05-09T00:00:00.000Z",
  block,
});

const suggestionPanel = message({
  type: "plugin_message",
  data: {
    specs: [{ component: "Button", on: { click: { action: "draftMessage" } } }],
  },
});

const formBlock = message({
  type: "interactive_form",
  data: { fields: [{ name: "name", type: "text" }] },
});

// `turnCount: 0` is the pre-game state — the "begin adventure" hero is still
// on screen. Default to a started session so the existing cases keep testing
// in-play behaviour.
const sessionRecord = (turnCount: number): SessionRecord => ({
  id: "session-1",
  worldId: "world-1",
  status: "active",
  turnCount,
  createdAt: "2026-05-09T00:00:00.000Z",
});

const setup = (messages: StreamMessage[], executing = false, turnCount = 1) => {
  const onSendMessage = vi.fn();
  const view = renderHook(() =>
    useGameViewComposer({
      messages,
      submittedBlockIds: new Set<string>(),
      executing,
      session: sessionRecord(turnCount),
      onSendMessage,
    }),
  );
  return { ...view, onSendMessage };
};

describe("useGameViewComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMock.pendingInteractionDrafts = [];
  });

  it("locks the composer while the begin-adventure hero is still waiting", () => {
    // Sending here would open a turn before any setup runtime has run, so the
    // narrator would answer in a world with no character and no opening scene.
    const { result } = setup([], false, 0);
    expect(result.current.awaitingBegin).toBe(true);
    expect(result.current.composerDisabled).toBe(true);
    // Not "blocked" — that word is reserved for an unanswered interaction, and
    // drives a placeholder telling the player to finish it.
    expect(result.current.composerBlocked).toBe(false);
  });

  it("refuses to send while awaiting begin, including via Enter", () => {
    const { result, onSendMessage } = setup([], false, 0);
    act(() => result.current.setInputValue("我想先说点什么"));
    act(() => result.current.handleSubmit());
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("releases the composer once pre-game starts executing", () => {
    // The hero disappears the moment the turn starts, so the composer should
    // follow it and become a steer surface rather than staying dead.
    const { result } = setup([], true, 0);
    expect(result.current.awaitingBegin).toBe(false);
    expect(result.current.composerDisabled).toBe(false);
  });

  it("releases the composer once the opening messages exist", () => {
    const { result } = setup([suggestionPanel], false, 0);
    expect(result.current.awaitingBegin).toBe(false);
  });

  it("keeps the composer usable when only suggestion panels are on screen", () => {
    const { result } = setup([suggestionPanel]);
    expect(result.current.composerBlocked).toBe(false);
  });

  it("blocks the composer while a must-answer form is unanswered", () => {
    const { result } = setup([formBlock]);
    expect(result.current.composerBlocked).toBe(true);
  });

  it("keeps the composer usable while selections sit in the draft bar", () => {
    sessionMock.pendingInteractionDrafts = [
      { id: "d1", label: "走近门口", values: { text: "走近门口" } },
    ];
    const { result } = setup([]);
    expect(result.current.composerBlocked).toBe(false);
  });

  it("sends queued selections and the typed line as one turn", () => {
    sessionMock.pendingInteractionDrafts = [
      {
        id: "d1",
        label: "走近门口",
        values: { text: "走近门口" },
        sourceBlockId: "block-1",
      },
    ];
    const { result, onSendMessage } = setup([]);

    act(() => result.current.setInputValue("同时留意她的表情"));
    act(() => result.current.handleSubmit());

    expect(onSendMessage).toHaveBeenCalledWith("走近门口\n同时留意她的表情");
    expect(sessionMock.submitBlock).toHaveBeenCalledWith(
      "block-1",
      expect.objectContaining({ _kind: "selection" }),
    );
    expect(sessionMock.clearInteractionDrafts).toHaveBeenCalled();
    expect(result.current.inputValue).toBe("");
  });

  it("steers instead of starting a turn while one is executing", () => {
    const { result, onSendMessage } = setup([], true);

    act(() => result.current.setInputValue("等一下"));
    act(() => result.current.handleSubmit());

    expect(sessionMock.steerMessage).toHaveBeenCalledWith("等一下");
    expect(onSendMessage).not.toHaveBeenCalled();
  });
});
