import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import type { TFunction } from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamMessage } from "@/stores/session-store.js";
import type { SessionRecord } from "@/services/api.js";
import type {
  ActionKindDescriptor,
  PluginRpcResponse,
  Seat,
  SessionActionKindsResponse,
  SessionSlashCommand,
} from "@covel/shared";
import { emitToast } from "@/lib/toast-channel.js";
import { useGameViewComposer } from "../game-view/use-game-view-composer.js";
import { MessageComposer } from "../game-view/message-composer.js";

const { postPluginRpcWithApproval } = vi.hoisted(() => ({
  postPluginRpcWithApproval: vi.fn(async (): Promise<PluginRpcResponse> => ({
    status: "ok" as const,
    result: { ok: true, message: "rolled" },
  })),
}));

vi.mock("@/lib/toast-channel.js", () => ({ emitToast: vi.fn() }));

vi.mock("@/components/session/plugin-rpc-ui.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/session/plugin-rpc-ui.js")
  >()),
  postPluginRpcWithApproval,
}));

// Composer availability is the player's core affordance, so it gets a
// deterministic test rather than relying on the live-LLM e2e run.
const sessionMock = {
  restoredInput: null as {
    requestId: string;
    content: string;
    kind?: string;
    fields?: Record<string, unknown>;
    drafts?: string;
  } | null,
  sessionActionKinds: null as SessionActionKindsResponse | null,
  gameState: {} as Record<string, unknown>,
  submitComposerAction: vi.fn(),
  switchSeatCharacter: vi.fn(async () => {}),
  clearRestoredInput: vi.fn(),
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
    clearRestoredInput: sessionMock.clearRestoredInput,
    state: {
      restoredInput: sessionMock.restoredInput,
      pendingInteractionDrafts: sessionMock.pendingInteractionDrafts,
      suspensions: sessionMock.suspensions,
      sessionActionKinds: sessionMock.sessionActionKinds,
      gameState: sessionMock.gameState,
    },
    submitComposerAction: sessionMock.submitComposerAction,
    switchSeatCharacter: sessionMock.switchSeatCharacter,
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
  autoAdvanceLimit: 3,
  completedPlayerTurns: phase === "playing" ? 1 : 0,
  setupRuntimes: {},
  seats: [
    { id: "main", controller: "human", role: "player", characters: "auto" },
  ],
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
  seats?: Seat[],
) => {
  const onSendMessage = vi.fn();
  const onCommandClientAction = vi.fn();
  const session = { ...sessionRecord(phase), ...(seats ? { seats } : {}) };
  const view = renderHook(() =>
    useGameViewComposer({
      messages,
      submittedBlockIds: new Set<string>(),
      executing,
      session,
      onSendMessage,
      commands,
      onCommandClientAction,
    }),
  );
  return { ...view, onSendMessage, onCommandClientAction };
};

describe("useGameViewComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMock.pendingInteractionDrafts = [];
    sessionMock.restoredInput = null;
    sessionMock.sessionActionKinds = null;
    sessionMock.gameState = {};
  });

  it("returns a stopped input once, ahead of text typed during the request", () => {
    const { result, rerender, onSendMessage } = setup([]);
    act(() => result.current.setInputValue("Look around"));
    act(() => result.current.handleSubmit());
    expect(onSendMessage).toHaveBeenCalledWith("Look around");
    act(() => result.current.setInputValue("Then ask the guard"));
    sessionMock.restoredInput = {
      requestId: "stopped",
      content: "Look around",
    };
    rerender();
    expect(result.current.inputValue).toBe("Look around\nThen ask the guard");
    expect(sessionMock.clearRestoredInput).toHaveBeenCalledExactlyOnceWith(
      "stopped",
    );
    rerender();
    expect(result.current.inputValue).toBe("Look around\nThen ask the guard");
    expect(onSendMessage).toHaveBeenCalledOnce();
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

  it("sends selections without requiring an extra typed line", () => {
    sessionMock.pendingInteractionDrafts = [
      {
        id: "draft-1",
        label: "Inspect the door",
        values: { text: "Inspect the door" },
      },
    ];
    const { result, onSendMessage } = setup([]);
    act(() => result.current.handleSubmit());
    expect(onSendMessage).toHaveBeenCalledWith("Inspect the door");
    expect(sessionMock.clearInteractionDrafts).toHaveBeenCalledOnce();
  });

  it("includes the typed line when confirming the selection bar", () => {
    sessionMock.pendingInteractionDrafts = [
      {
        id: "draft-1",
        label: "Inspect the door",
        values: { text: "Inspect the door" },
      },
    ];
    const { result, onSendMessage } = setup([]);
    act(() => result.current.setInputValue("Keep the evidence intact"));
    act(() => result.current.handleConfirmDrafts());
    expect(onSendMessage).toHaveBeenCalledWith(
      "Inspect the door\nKeep the evidence intact",
    );
    expect(result.current.inputValue).toBe("");
  });

  it("runs a command independently from either send entry while retaining queued selections", async () => {
    sessionMock.pendingInteractionDrafts = [
      {
        id: "draft-1",
        label: "Inspect the door",
        values: { text: "Inspect the door" },
      },
    ];
    const { result, onSendMessage } = setup([], false, "playing", [
      rollCommand,
    ]);
    act(() => result.current.setInputValue("/roll 2d6"));
    act(() => result.current.handleConfirmDrafts());
    await waitFor(() =>
      expect(postPluginRpcWithApproval).toHaveBeenCalledOnce(),
    );
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(sessionMock.clearInteractionDrafts).not.toHaveBeenCalled();
  });

  it("steers instead of starting a turn while one is executing", () => {
    const { result, onSendMessage } = setup([], true);

    act(() => result.current.setInputValue("等一下"));
    act(() => result.current.handleSubmit());

    expect(sessionMock.steerMessage).toHaveBeenCalledWith("等一下");
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("returns a refused interjection to the input box and says it was not sent", async () => {
    sessionMock.steerMessage.mockResolvedValueOnce(false);
    const { result, onSendMessage } = setup([], true);

    act(() => result.current.setInputValue("one more thing"));
    act(() => result.current.handleSubmit());
    expect(result.current.inputValue).toBe("");
    // Typed while the request was in flight: kept, after the refused text.
    act(() => result.current.setInputValue("and this"));

    await waitFor(() =>
      expect(result.current.inputValue).toBe("one more thing\nand this"),
    );
    expect(result.current.commandFeedback?.tone).toBe("info");
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("shows no refusal note for an interjection the turn took", async () => {
    const { result } = setup([], true);

    act(() => result.current.setInputValue("one more thing"));
    act(() => result.current.handleSubmit());

    await waitFor(() => expect(sessionMock.steerMessage).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.inputValue).toBe("");
    expect(result.current.commandFeedback).toBeNull();
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
          request: {
            kind: "command",
            commandId: "dice-check:roll",
            input: "/roll 2d6",
          },
        }),
      ),
    );
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(sessionMock.clearInteractionDrafts).not.toHaveBeenCalled();
  });

  it("holds a command typed before the command list is read, then runs it as a command", async () => {
    const onSendMessage = vi.fn();
    const { result, rerender } = renderHook(
      (props: {
        commands: readonly SessionSlashCommand[];
        commandsLoaded: boolean;
      }) =>
        useGameViewComposer({
          messages: [],
          submittedBlockIds: new Set<string>(),
          executing: false,
          session: sessionRecord("playing"),
          onSendMessage,
          ...props,
        }),
      {
        initialProps: {
          commands: [] as readonly SessionSlashCommand[],
          commandsLoaded: false,
        },
      },
    );

    act(() => result.current.setInputValue("/roll 2d6"));
    act(() => result.current.handleSubmit());
    // Not a player turn: the line stays in the box and the list is asked for.
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(postPluginRpcWithApproval).not.toHaveBeenCalled();
    expect(result.current.inputValue).toBe("/roll 2d6");
    expect(result.current.commandFeedback?.tone).toBe("info");
    expect(sessionMock.loadSessionPlugins).toHaveBeenCalledTimes(1);

    rerender({ commands: [rollCommand], commandsLoaded: true });
    await waitFor(() =>
      expect(postPluginRpcWithApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          request: {
            kind: "command",
            commandId: "dice-check:roll",
            input: "/roll 2d6",
          },
        }),
      ),
    );
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("drops a held command when the player edits the line before the list arrives", () => {
    const onSendMessage = vi.fn();
    const { result, rerender } = renderHook(
      (props: {
        commands: readonly SessionSlashCommand[];
        commandsLoaded: boolean;
      }) =>
        useGameViewComposer({
          messages: [],
          submittedBlockIds: new Set<string>(),
          executing: false,
          session: sessionRecord("playing"),
          onSendMessage,
          ...props,
        }),
      {
        initialProps: {
          commands: [] as readonly SessionSlashCommand[],
          commandsLoaded: false,
        },
      },
    );

    act(() => result.current.setInputValue("/roll 2d6"));
    act(() => result.current.handleSubmit());
    act(() => result.current.setInputValue("look around"));
    rerender({ commands: [rollCommand], commandsLoaded: true });

    expect(postPluginRpcWithApproval).not.toHaveBeenCalled();
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(result.current.inputValue).toBe("look around");
  });

  it("preserves an optional plugin filter from a diagnostics client action", async () => {
    postPluginRpcWithApproval.mockResolvedValueOnce({
      status: "ok",
      result: {
        ok: true,
        clientAction: { type: "open-plugin-diagnostics" },
      },
    });
    const first = setup([], false, "playing", [rollCommand]);
    act(() => first.result.current.setInputValue("/roll"));
    act(() => first.result.current.handleSubmit());
    await waitFor(() =>
      expect(first.onCommandClientAction).toHaveBeenCalledWith({
        type: "open-plugin-diagnostics",
        pluginId: undefined,
      }),
    );

    postPluginRpcWithApproval.mockResolvedValueOnce({
      status: "ok",
      result: {
        ok: true,
        clientAction: {
          type: "open-plugin-diagnostics",
          pluginId: "guide",
        },
      },
    });
    const second = setup([], false, "playing", [rollCommand]);
    act(() => second.result.current.setInputValue("/roll"));
    act(() => second.result.current.handleSubmit());
    await waitFor(() =>
      expect(second.onCommandClientAction).toHaveBeenCalledWith({
        type: "open-plugin-diagnostics",
        pluginId: "guide",
      }),
    );
  });

  it("keeps known commands out of mid-turn steer", async () => {
    const { result } = setup([], true, "playing", [rollCommand]);

    act(() => result.current.setInputValue("/r"));
    act(() => result.current.handleSubmit());

    await waitFor(() => expect(postPluginRpcWithApproval).toHaveBeenCalled());
    expect(sessionMock.steerMessage).not.toHaveBeenCalled();
  });
  it("retains command input and reports a failed runtime even without error text", async () => {
    postPluginRpcWithApproval.mockResolvedValueOnce({
      status: "ok",
      runtimeResults: [
        {
          runtimeId: "dice-check/roll",
          pluginId: "dice-check",
          status: "failed",
          durationMs: 1,
          output: null,
        },
      ],
    });
    const { result } = setup([], false, "playing", [rollCommand]);
    act(() => result.current.setInputValue("/roll 2d6"));
    act(() => result.current.handleSubmit());
    await waitFor(() =>
      expect(result.current.commandFeedback?.tone).toBe("error"),
    );
    expect(result.current.inputValue).toBe("/roll 2d6");
  });
});

const baseKind = (
  kind: string,
  roles: ActionKindDescriptor["roles"],
  text: ActionKindDescriptor["text"],
  actor: boolean,
): ActionKindDescriptor => ({
  kind,
  roles,
  text,
  actor,
  source: "framework",
  display: { label: kind },
});

const whisperKind: ActionKindDescriptor = {
  kind: "whisper-pack/whisper",
  roles: ["player"],
  text: "optional",
  actor: true,
  source: "plugin",
  pluginId: "whisper-pack",
  display: { label: "Whisper" },
  fieldsSchema: {
    type: "object",
    properties: {
      target: { type: "string", title: "Target" },
      volume: { type: "integer", minimum: 1, maximum: 10 },
      secret: { type: "boolean" },
    },
    required: ["target"],
  },
};

const catalogue = (
  seatId: string,
  role: "player" | "host",
  allowed: string[],
): SessionActionKindsResponse => ({
  kinds: [
    baseKind("say", ["player"], "required", true),
    baseKind("act", ["player"], "required", true),
    baseKind("narrate", ["host"], "required", false),
    baseKind("advance", ["host"], "none", false),
    baseKind("command", ["player", "host"], "required", false),
    whisperKind,
  ],
  seats: [{ seatId, role, controller: "human", allowed }],
});

describe("useGameViewComposer modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMock.pendingInteractionDrafts = [];
    sessionMock.restoredInput = null;
    sessionMock.gameState = {};
    sessionMock.sessionActionKinds = catalogue("main", "player", [
      "say",
      "act",
      "command",
      "whisper-pack/whisper",
    ]);
  });

  it("sends a say as the plain text it always was", () => {
    const { result, onSendMessage } = setup([]);
    act(() => result.current.setInputValue("Look around"));
    act(() => result.current.handleSubmit());
    expect(onSendMessage).toHaveBeenCalledExactlyOnceWith("Look around");
    expect(sessionMock.submitComposerAction).not.toHaveBeenCalled();
  });

  it("submits the text as an act in act mode", () => {
    const { result, onSendMessage } = setup([]);
    act(() => result.current.composerModes.selectKind("act"));
    act(() => result.current.setInputValue("  Open the door "));
    act(() => result.current.handleSubmit());
    expect(sessionMock.submitComposerAction).toHaveBeenCalledExactlyOnceWith(
      { kind: "act", text: "Open the door" },
      undefined,
    );
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(result.current.inputValue).toBe("");
  });

  it("submits an advance without text, naming the host seat", () => {
    const host: Seat = {
      id: "gm",
      controller: "human",
      role: "host",
      characters: [],
    };
    sessionMock.sessionActionKinds = catalogue("gm", "host", [
      "narrate",
      "advance",
    ]);
    const { result } = setup([], false, "playing", [], [host]);
    expect(result.current.composerModes.modes.map((m) => m.kind)).toEqual([
      "narrate",
      "advance",
    ]);
    act(() => result.current.composerModes.selectKind("advance"));
    expect(result.current.canSubmit).toBe(true);
    act(() => result.current.handleSubmit());
    expect(sessionMock.submitComposerAction).toHaveBeenCalledExactlyOnceWith(
      { kind: "advance", seatId: "gm" },
      undefined,
    );
  });

  it("sends a plugin kind with its typed fields", () => {
    const { result } = setup([]);
    act(() => result.current.composerModes.selectKind("whisper-pack/whisper"));
    act(() => result.current.composerModes.setFieldValue("target", "Bo"));
    act(() => result.current.composerModes.setFieldValue("volume", 3));
    act(() => result.current.composerModes.setFieldValue("secret", true));
    act(() => result.current.setInputValue("psst"));
    act(() => result.current.handleSubmit());
    expect(sessionMock.submitComposerAction).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "whisper-pack/whisper",
        text: "psst",
        fields: { target: "Bo", volume: 3, secret: true },
      },
      undefined,
    );
    // An unchecked checkbox is `false`, before and after.
    expect(result.current.composerModes.fieldValues).toEqual({ secret: false });
  });

  it("refuses to send while a required field is empty", () => {
    const { result } = setup([]);
    act(() => result.current.composerModes.selectKind("whisper-pack/whisper"));
    act(() => result.current.setInputValue("psst"));
    act(() => result.current.handleSubmit());
    expect(sessionMock.submitComposerAction).not.toHaveBeenCalled();
    expect(emitToast).toHaveBeenCalledWith(
      "error",
      expect.any(String),
      "Target",
    );
    expect(result.current.inputValue).toBe("psst");
  });

  it("sends queued selections ahead of an act", () => {
    sessionMock.pendingInteractionDrafts = [
      { id: "d1", label: "Wait", values: { text: "Wait" } },
    ];
    const { result, onSendMessage } = setup([]);
    act(() => result.current.composerModes.selectKind("act"));
    act(() => result.current.setInputValue("Draw the sword"));
    act(() => result.current.handleSubmit());
    expect(sessionMock.submitComposerAction).toHaveBeenCalledExactlyOnceWith(
      { kind: "act", text: "Draw the sword" },
      { drafts: "Wait" },
    );
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(sessionMock.clearInteractionDrafts).toHaveBeenCalledOnce();
  });

  it("sends nothing and keeps the queued selections when an act has no text", () => {
    sessionMock.pendingInteractionDrafts = [
      { id: "d1", label: "Wait", values: { text: "Wait" } },
    ];
    const { result, onSendMessage } = setup([]);
    act(() => result.current.composerModes.selectKind("act"));
    expect(result.current.canSubmit).toBe(false);
    act(() => result.current.handleSubmit());
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(sessionMock.submitComposerAction).not.toHaveBeenCalled();
    expect(sessionMock.clearInteractionDrafts).not.toHaveBeenCalled();

    // Typing the action's text sends both, the selections first.
    act(() => result.current.setInputValue("Draw the sword"));
    expect(result.current.canSubmit).toBe(true);
    act(() => result.current.handleSubmit());
    expect(sessionMock.submitComposerAction).toHaveBeenCalledExactlyOnceWith(
      { kind: "act", text: "Draw the sword" },
      { drafts: "Wait" },
    );
  });

  it("disables the send for another mode while a turn executes but still steers a say", () => {
    const { result } = setup([], true);
    act(() => result.current.composerModes.selectKind("act"));
    act(() => result.current.setInputValue("Swing"));
    expect(result.current.canSubmit).toBe(false);
    act(() => result.current.handleSubmit());
    expect(sessionMock.submitComposerAction).not.toHaveBeenCalled();
    expect(sessionMock.steerMessage).not.toHaveBeenCalled();

    act(() => result.current.composerModes.selectKind("say"));
    expect(result.current.canSubmit).toBe(true);
    act(() => result.current.handleSubmit());
    expect(sessionMock.steerMessage).toHaveBeenCalledWith("Swing");
  });

  it("keeps the rendered send button on for a slash command while a turn executes in another mode", async () => {
    const onSendMessage = vi.fn();
    const session = sessionRecord("playing");
    const Harness = () => {
      const composer = useGameViewComposer({
        messages: [],
        submittedBlockIds: new Set<string>(),
        executing: true,
        session,
        onSendMessage,
        commands: [rollCommand],
      });
      return createElement(MessageComposer, {
        t: ((_key: string, fallback?: string) => fallback ?? _key) as TFunction,
        session,
        executing: true,
        inputValue: composer.inputValue,
        composerBlocked: composer.composerBlocked,
        composerDisabled: composer.composerDisabled,
        awaitingBegin: composer.awaitingBegin,
        onInputValueChange: composer.setInputValue,
        onSubmit: composer.handleSubmit,
        onKeyDown: composer.handleKeyDown,
        commandMatches: composer.commandMatches,
        commandMenuOpen: composer.commandMenuOpen,
        commandExecuting: composer.commandExecuting,
        composerModes: composer.composerModes,
        canSubmit: composer.canSubmit,
      });
    };
    render(createElement(Harness));
    const send = () =>
      document.querySelector<HTMLButtonElement>(".ui-composer-submit")!;
    const input = screen.getByTestId("game-composer-input");
    fireEvent.click(screen.getByTestId("composer-mode-act"));
    fireEvent.change(input, { target: { value: "Swing" } });
    expect(send().disabled).toBe(true);
    fireEvent.change(input, { target: { value: "/roll 2d6" } });
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    await waitFor(() =>
      expect(postPluginRpcWithApproval).toHaveBeenCalledOnce(),
    );
    expect(sessionMock.steerMessage).not.toHaveBeenCalled();
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("runs slash commands in any mode", async () => {
    const { result, onSendMessage } = setup([], false, "playing", [
      rollCommand,
    ]);
    act(() => result.current.composerModes.selectKind("act"));
    act(() => result.current.setInputValue("/roll 2d6"));
    act(() => result.current.handleSubmit());
    await waitFor(() =>
      expect(postPluginRpcWithApproval).toHaveBeenCalledOnce(),
    );
    expect(sessionMock.submitComposerAction).not.toHaveBeenCalled();
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("sends an unknown slash line to the command path in any mode", () => {
    const { result, onSendMessage } = setup([]);
    act(() => result.current.composerModes.selectKind("act"));
    act(() => result.current.setInputValue("/unknown"));
    act(() => result.current.handleSubmit());
    expect(onSendMessage).toHaveBeenCalledExactlyOnceWith("/unknown");
    expect(sessionMock.submitComposerAction).not.toHaveBeenCalled();
  });

  it("keeps the host seat on an unknown slash line in a host-only session", () => {
    const host: Seat = {
      id: "gm",
      controller: "human",
      role: "host",
      characters: [],
    };
    sessionMock.sessionActionKinds = catalogue("gm", "host", [
      "narrate",
      "advance",
      "command",
    ]);
    const { result, onSendMessage } = setup([], false, "playing", [], [host]);
    act(() => result.current.setInputValue("/unknown"));
    act(() => result.current.handleSubmit());
    expect(sessionMock.submitComposerAction).toHaveBeenCalledExactlyOnceWith({
      kind: "command",
      text: "/unknown",
      seatId: "gm",
    });
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("takes back the mode, text and fields of a submission stopped before it started", () => {
    const { result, rerender } = setup([]);
    sessionMock.restoredInput = {
      requestId: "stopped",
      content: "psst",
      kind: "whisper-pack/whisper",
      fields: { target: "Bo" },
    };
    rerender();
    expect(result.current.inputValue).toBe("psst");
    expect(result.current.composerModes.mode.kind).toBe("whisper-pack/whisper");
    expect(result.current.composerModes.fieldValues).toEqual({
      target: "Bo",
      secret: false,
    });
  });

  it("sends the queued selections of a stopped submission with the action typed again", () => {
    const { result, rerender } = setup([]);
    sessionMock.restoredInput = {
      requestId: "stopped",
      content: "Draw the sword",
      kind: "act",
      drafts: "Wait",
    };
    rerender();
    expect(result.current.inputValue).toBe("Draw the sword");
    expect(result.current.composerModes.mode.kind).toBe("act");
    act(() => result.current.handleSubmit());
    expect(sessionMock.submitComposerAction).toHaveBeenCalledExactlyOnceWith(
      { kind: "act", text: "Draw the sword" },
      { drafts: "Wait" },
    );
    // Sent once: the next submission carries no old selections.
    act(() => result.current.setInputValue("Again"));
    act(() => result.current.handleSubmit());
    expect(sessionMock.submitComposerAction).toHaveBeenLastCalledWith(
      { kind: "act", text: "Again" },
      undefined,
    );
  });

  it("falls back to the first mode when the selected one leaves the catalogue, and stays there when it returns", () => {
    const full = sessionMock.sessionActionKinds;
    const { result, rerender } = setup([]);
    act(() => result.current.composerModes.selectKind("act"));
    expect(result.current.composerModes.mode.kind).toBe("act");
    sessionMock.sessionActionKinds = catalogue("main", "player", ["say"]);
    rerender();
    expect(result.current.composerModes.mode.kind).toBe("say");
    expect(result.current.composerModes.modes).toHaveLength(1);

    // A catalogue read that fails and then succeeds again does not bring the
    // old mode back.
    sessionMock.sessionActionKinds = null;
    rerender();
    sessionMock.sessionActionKinds = full;
    rerender();
    expect(result.current.composerModes.modes.length).toBeGreaterThan(1);
    expect(result.current.composerModes.mode.kind).toBe("say");
  });

  it("offers the character switcher only for a seat with several characters", () => {
    sessionMock.gameState = {
      characters: [
        { id: "aya", name: "Aya", type: "player" },
        { id: "bo", name: "Bo", type: "player" },
      ],
    };
    const { result } = setup([]);
    expect(result.current.composerModes.switcher?.options).toEqual([
      { id: "aya", name: "Aya" },
      { id: "bo", name: "Bo" },
    ]);
    act(() => result.current.composerModes.selectKind("act"));
    expect(result.current.composerModes.switcher).not.toBeNull();
  });
});
