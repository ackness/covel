import { useReducer } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Seat } from "@covel/shared";
import * as api from "@/services/api";
import type { DataService, SessionWorkspace } from "@/services/data-service.js";
import { useBuildSessionActions } from "../actions.js";
import { initialState, reducer } from "../reducer.js";
import { createSseEventHandler } from "../sse-handler.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";

const session: api.SessionRecord = {
  id: "session-1",
  worldId: "world-1",
  status: "active",
  phase: "playing",
  completedPlayerTurns: 1,
  setupRuntimes: {},
  seats: [
    { id: "main", controller: "human", role: "player", characters: "auto" },
  ],
  activePlugins: [],
  locale: "en-US",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const gameState = {
  characters: [
    { id: "aya", name: "Aya", type: "player" },
    { id: "bo", name: "Bo", type: "player" },
  ],
};

function renderActions(workspace: SessionWorkspace) {
  const ds = {} as DataService;
  return renderHook(() => {
    const [state, dispatch] = useReducer(reducer, {
      ...initialState,
      session,
      gameState,
    });
    const refs = useSessionRuntimeRefs(state);
    const handleSseEvent = createSseEventHandler({ ...refs, dispatch, ds });
    return {
      state,
      actions: useBuildSessionActions({
        state,
        dispatch,
        ds,
        workspace,
        refs,
        handleSseEvent,
      }),
    };
  });
}

const passthrough: SessionWorkspace = {
  run: (_id, _request, mutate) => mutate(),
  hydrate: vi.fn(),
  checkpoint: vi.fn(),
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "getSession").mockResolvedValue(session);
});

describe("submitComposerAction", () => {
  it("sends a plugin kind with its fields and echoes the acting character", async () => {
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    const { result } = renderActions(passthrough);
    await act(async () =>
      result.current.actions.submitComposerAction({
        kind: "act",
        text: "Draw the sword",
        fields: { stance: "high" },
      }),
    );
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "submit_actions",
      payload: {
        actions: [
          { kind: "act", text: "Draw the sword", fields: { stance: "high" } },
        ],
        inputMessageId: expect.any(String),
      },
    });
    expect(result.current.state.messages).toMatchObject([
      {
        role: "user",
        content: "Draw the sword",
        actions: [{ kind: "act", seatId: "main", actorId: "aya" }],
      },
    ]);
  });

  it("sends queued selections first as a say", async () => {
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    const { result } = renderActions(passthrough);
    await act(async () =>
      result.current.actions.submitComposerAction(
        { kind: "act", text: "Draw the sword" },
        { drafts: "Wait" },
      ),
    );
    const request = send.mock.calls[0]?.[0] as unknown as {
      payload: { actions: unknown[] };
    };
    expect(request.payload.actions).toEqual([
      { kind: "say", text: "Wait" },
      { kind: "act", text: "Draw the sword" },
    ]);
    expect(result.current.state.messages[0]?.content).toBe(
      "Wait\nDraw the sword",
    );
  });

  it("sends an advance without an echo or an input message", async () => {
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    const { result } = renderActions(passthrough);
    await act(async () =>
      result.current.actions.submitComposerAction({
        kind: "advance",
        seatId: "gm",
      }),
    );
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      payload: { actions: [{ kind: "advance", seatId: "gm" }] },
    });
    expect(send.mock.calls[0]?.[0].payload).not.toHaveProperty(
      "inputMessageId",
    );
    expect(result.current.state.messages).toEqual([]);
  });

  it("keeps sendMessage's plain say and command requests", async () => {
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    const { result } = renderActions(passthrough);
    await act(async () => result.current.actions.sendMessage("Look around"));
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      payload: { actions: [{ kind: "say", text: "Look around" }] },
    });
  });
});

describe("a submission stopped before it started", () => {
  const stopped = {
    type: "execution.completed",
    requestId: "",
    traceId: "t",
    sessionId: "session-1",
    seq: 0,
    timestamp: "2026-01-01T00:00:00Z",
    payload: { committed: false, abortReason: "aborted-by-player" },
  };

  it("comes back as the queued selections and the typed action, and sends the same request again", async () => {
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    const { result } = renderActions(passthrough);
    await act(async () =>
      result.current.actions.submitComposerAction(
        { kind: "act", text: "Draw the sword" },
        { drafts: "Wait" },
      ),
    );
    const first = send.mock.calls[0]!;
    const sent = first[0] as unknown as { requestId: string };
    await act(async () => {
      first[1]({ ...stopped, requestId: sent.requestId } as never);
      first[3]?.();
    });
    expect(result.current.state.messages).toEqual([]);
    const restored = result.current.state.restoredInput;
    expect(restored).toEqual({
      requestId: sent.requestId,
      content: "Draw the sword",
      kind: "act",
      drafts: "Wait",
    });

    // The composer gives back exactly what it was handed.
    await act(async () =>
      result.current.actions.submitComposerAction(
        { kind: restored!.kind!, text: restored!.content },
        { drafts: restored!.drafts },
      ),
    );
    expect(
      (send.mock.calls[1]![0] as unknown as { payload: { actions: unknown } })
        .payload.actions,
    ).toEqual(
      (first[0] as unknown as { payload: { actions: unknown } }).payload
        .actions,
    );
  });

  it("does not turn the summary of a fields-only action into typed text", async () => {
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    const { result } = renderActions(passthrough);
    await act(async () =>
      result.current.actions.submitComposerAction({
        kind: "p/whisper",
        fields: { target: "Bo" },
      }),
    );
    const first = send.mock.calls[0]!;
    const sent = first[0] as unknown as { requestId: string };
    await act(async () => {
      first[1]({ ...stopped, requestId: sent.requestId } as never);
      first[3]?.();
    });
    expect(result.current.state.restoredInput).toEqual({
      requestId: sent.requestId,
      content: "",
      kind: "p/whisper",
      fields: { target: "Bo" },
    });
  });
});

describe("a submission during a character switch", () => {
  it("waits for the switch and names the character it switched to", async () => {
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    let finish!: (value: { seats: Seat[] }) => void;
    vi.spyOn(api, "setSeatCurrentCharacter").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = renderActions(passthrough);
    let switching!: Promise<void>;
    act(() => {
      switching = result.current.actions.switchSeatCharacter("main", "bo");
    });
    act(() =>
      result.current.actions.submitComposerAction({
        kind: "act",
        text: "Draw the sword",
      }),
    );
    // Nothing goes out, and nothing is shown as the old character.
    expect(send).not.toHaveBeenCalled();
    expect(result.current.state.messages).toEqual([]);

    await act(async () => {
      finish({ seats: [{ ...session.seats[0]!, currentCharacterId: "bo" }] });
      await switching;
    });
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(result.current.state.session?.seats[0]?.currentCharacterId).toBe(
      "bo",
    );
    expect(result.current.state.messages).toMatchObject([
      { actions: [{ kind: "act", actorId: "bo" }] },
    ]);
  });

  it("sends as the same character when the switch fails", async () => {
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    let fail!: (error: Error) => void;
    vi.spyOn(api, "setSeatCurrentCharacter").mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { result } = renderActions(passthrough);
    let switching!: Promise<void>;
    act(() => {
      switching = result.current.actions.switchSeatCharacter("main", "bo");
      switching.catch(() => {});
    });
    act(() =>
      result.current.actions.submitComposerAction({ kind: "say", text: "Hi" }),
    );
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      fail(new Error("busy"));
      await switching.catch(() => {});
    });
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(result.current.state.messages).toMatchObject([
      { actions: [{ kind: "say", actorId: "aya" }] },
    ]);
  });
});

describe("switchSeatCharacter", () => {
  it("switches inside the workspace and applies the returned seats", async () => {
    const seats = [{ ...session.seats[0]!, currentCharacterId: "bo" }];
    const patch = vi
      .spyOn(api, "setSeatCurrentCharacter")
      .mockResolvedValue({ seats });
    const sessions: string[] = [];
    const run: SessionWorkspace["run"] = (sessionId, _request, mutate) => {
      sessions.push(sessionId);
      return mutate();
    };
    const { result } = renderActions({ ...passthrough, run });
    await act(async () =>
      result.current.actions.switchSeatCharacter("main", "bo"),
    );
    expect(sessions).toEqual(["session-1"]);
    expect(patch).toHaveBeenCalledWith("session-1", "main", "bo");
    expect(result.current.state.session?.seats).toEqual(seats);
  });

  it("rejects and keeps the seats when the server refuses", async () => {
    vi.spyOn(api, "setSeatCurrentCharacter").mockRejectedValue(
      new Error("not bound"),
    );
    const { result } = renderActions(passthrough);
    await expect(
      act(async () =>
        result.current.actions.switchSeatCharacter("main", "ghost"),
      ),
    ).rejects.toThrow("not bound");
    expect(result.current.state.session?.seats).toEqual(session.seats);
  });
});
