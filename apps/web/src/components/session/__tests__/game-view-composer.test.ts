import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamMessage } from "@/stores/session-store.js";
import type { SessionRecord } from "@/services/api.js";
import type { SessionSlashCommand } from "@covel/shared";
import { useGameViewComposer } from "../game-view/use-game-view-composer.js";

const { postPluginRpcWithApproval } = vi.hoisted(() => ({
  postPluginRpcWithApproval: vi.fn(async () => ({
    status: "ok" as const,
    result: { ok: true, message: "rolled" },
  })),
}));

vi.mock("@/components/session/plugin-rpc-ui.js", () => ({
  postPluginRpcWithApproval,
}));

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
  loadSessionPlugins: vi.fn(async () => {}),
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
    loadSessionPlugins: sessionMock.loadSessionPlugins,
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

// `phase: "setup"` is the pre-game state — the "begin adventure" hero is still
// on screen. Default to a started session so the existing cases keep testing
// in-play behaviour.
const sessionRecord = (phase: "setup" | "playing"): SessionRecord => ({
  id: "session-1",
  worldId: "world-1",
  status: "active",
  phase,
  completedPlayerTurns: phase === "playing" ? 1 : 0,
  setupRuntimes: {},
  activePlugins: [],
  locale: "en-US",
  createdAt: "2026-05-09T00:00:00.000Z",
  updatedAt: "2026-05-09T00:00:00.000Z",
});

const rollCommand: SessionSlashCommand = {
  id: "dice-check:roll",
  pluginId: "dice-check",
  source: "plugin",
  sourceLabel: "Dice Check",
  name: "roll",
  aliases: ["r"],
  description: "Roll dice",
  arguments: [{ name: "notation" }],
  action: "roll",
};

const setup = (
  messages: StreamMessage[],
  executing = false,
  phase: "setup" | "playing" = "playing",
  commands: readonly SessionSlashCommand[] = [],
) => {
  const onSendMessage = vi.fn();
  const view = renderHook(() =>
    useGameViewComposer({
      messages,
      submittedBlockIds: new Set<string>(),
      executing,
      session: sessionRecord(phase),
      onSendMessage,
      commands,
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
    const { result } = setup([], false, "setup");
    expect(result.current.awaitingBegin).toBe(true);
    expect(result.current.composerDisabled).toBe(true);
    // Not "blocked" — that word is reserved for an unanswered interaction, and
    // drives a placeholder telling the player to finish it.
    expect(result.current.composerBlocked).toBe(false);
  });

  it("refuses to send while awaiting begin, including via Enter", () => {
    const { result, onSendMessage } = setup([], false, "setup");
    act(() => result.current.setInputValue("我想先说点什么"));
    act(() => result.current.handleSubmit());
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("releases the composer once pre-game starts executing", () => {
    // The hero disappears the moment the turn starts, so the composer should
    // follow it and become a steer surface rather than staying dead.
    const { result } = setup([], true, "setup");
    expect(result.current.awaitingBegin).toBe(false);
    expect(result.current.composerDisabled).toBe(false);
  });

  it("releases the composer once the opening messages exist", () => {
    const { result } = setup([suggestionPanel], false, "setup");
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

  it("completes a partial slash command before executing it", () => {
    const { result, onSendMessage } = setup([], false, "playing", [
      rollCommand,
    ]);

    act(() => result.current.setInputValue("/ro"));
    act(() => result.current.handleSubmit());

    expect(result.current.inputValue).toBe("/roll ");
    expect(postPluginRpcWithApproval).not.toHaveBeenCalled();
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("dispatches an exact command separately from drafts and the story turn", async () => {
    sessionMock.pendingInteractionDrafts = [
      { id: "d1", label: "wait", values: { text: "wait" } },
    ];
    const { result, onSendMessage } = setup([], false, "playing", [
      rollCommand,
    ]);

    act(() => result.current.setInputValue("/roll 2d6"));
    act(() => result.current.handleSubmit());

    await waitFor(() =>
      expect(postPluginRpcWithApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          request: { commandId: "dice-check:roll", input: "/roll 2d6" },
        }),
      ),
    );
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(sessionMock.clearInteractionDrafts).not.toHaveBeenCalled();
  });

  it("keeps known commands out of mid-turn steer", async () => {
    const { result } = setup([], true, "playing", [rollCommand]);

    act(() => result.current.setInputValue("/r"));
    act(() => result.current.handleSubmit());

    await waitFor(() => expect(postPluginRpcWithApproval).toHaveBeenCalled());
    expect(sessionMock.steerMessage).not.toHaveBeenCalled();
  });
});
