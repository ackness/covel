// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SseEnvelope } from "@covel/shared";
import { submitInteractionBlock } from "../interaction-submission.js";
import { claimSessionAction } from "../runtime-refs.js";
import { initialState } from "../reducer.js";
import { ApiError } from "@/services/api/request.js";

const api = vi.hoisted(() => ({
  sendAction: vi.fn(),
  getSessionView: vi.fn(),
  resolveApproval: vi.fn(),
  listSessionPlugins: vi.fn(),
}));
vi.mock("@/services/api.js", () => api);
vi.mock("@/lib/confirm-channel.js", () => ({ requestConfirm: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast-channel.js", () => ({ emitToast: toast }));

const submission: Parameters<typeof submitInteractionBlock>[1] = [
  "block-1",
  "turn-1",
  "form-1",
  "form",
  { name: "Player", points: "3" },
];

function envelope(
  type: string,
  payload: Record<string, unknown> = {},
): SseEnvelope {
  return {
    type,
    requestId: "request",
    traceId: "trace",
    sessionId: "session-1",
    turnId: "follow-up-turn",
    flowId: "trace",
    seq: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
    payload,
  };
}

const stored = envelope("interaction.submitted", {
  interactionTurnId: "turn-1",
  results: [
    {
      submissionId: "input-1",
      interactionId: "form-1",
      values: { name: "Player", points: 3 },
      filledNarrative: "Ready",
    },
  ],
  message: { id: "server-message", content: "Ready" },
});

/** The open stream of the one request a submission makes. */
function stream(call = 0) {
  const [request, onEvent, onError, onDone] = api.sendAction.mock.calls[
    call
  ]! as [
    Record<string, unknown>,
    (event: SseEnvelope) => void,
    (error: Error) => void,
    () => void,
  ];
  return { request, onEvent, onError, onDone };
}

/** Answer the next request with these events and close its stream. */
function answerWith(...events: SseEnvelope[]) {
  api.sendAction.mockImplementationOnce(
    (_request, onEvent, _onError, onDone) => {
      for (const event of events) onEvent(event);
      onDone();
    },
  );
}

function makeDeps(): Parameters<typeof submitInteractionBlock>[0] {
  const sessionIdRef = { current: "session-1" as string | null };
  const activeActionRef = { current: null as symbol | null };
  return {
    dispatch: vi.fn(),
    workspace: { run: async (_sid, _requestId, action) => action() },
    sessionIdRef,
    stateRef: {
      current: {
        ...initialState,
        session: { id: "session-1", status: "active" } as NonNullable<
          typeof initialState.session
        >,
      },
    },
    claimAction: (sid) =>
      claimSessionAction(activeActionRef, sessionIdRef, sid),
    handleSseEvent: vi.fn(),
    resyncSession: vi.fn(),
    inFlight: new Set(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getSessionView.mockRejectedValue(new Error("Refresh unavailable"));
  api.listSessionPlugins.mockResolvedValue({ items: [], commands: [] });
});

describe("interaction submission", () => {
  it("does not steal the running turn's stream ownership", async () => {
    const deps = makeDeps();
    const running = deps.claimAction("session-1");
    deps.stateRef.current.executing = true;
    await submitInteractionBlock(deps, submission);
    expect(running.isCurrent()).toBe(true);
    expect(api.sendAction).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("answers the form and runs its turn with one request", async () => {
    const deps = makeDeps();
    const started = envelope("execution.started", { runtimeCount: 1 });
    const completed = envelope("execution.completed", { committed: true });
    answerWith(stored, started, completed);
    await expect(
      submitInteractionBlock(deps, submission),
    ).resolves.toBeUndefined();

    expect(api.sendAction).toHaveBeenCalledOnce();
    expect(stream().request).toMatchObject({
      type: "submit_interaction",
      sessionId: "session-1",
      payload: {
        turnId: "turn-1",
        submissions: [
          {
            interactionId: "form-1",
            type: "form",
            values: { name: "Player", points: "3" },
          },
        ],
      },
    });
    // The block shows what the server stored, not what was typed.
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "SUBMIT_BLOCK",
      blockId: "block-1",
      values: { name: "Player", points: 3 },
    });
    // The player's bubble carries the stored message's id and its turn.
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "ADD_MESSAGE",
      message: {
        id: "server-message",
        role: "user",
        content: "Ready",
        timestamp: stored.timestamp,
        turnId: "follow-up-turn",
      },
    });
    // The rest of the stream is an ordinary turn.
    expect(vi.mocked(deps.handleSseEvent).mock.calls).toEqual([
      [started],
      [completed],
    ]);
    expect(deps.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "FINALIZE_HANGING_RUNTIMES" }),
    );
    expect(deps.resyncSession).toHaveBeenCalledOnce();
    expect(deps.inFlight.size).toBe(0);
  });

  it("adds no player bubble for an answer the interaction keeps silent", async () => {
    const deps = makeDeps();
    answerWith(
      envelope("interaction.submitted", {
        results: [{ interactionId: "form-1", values: { name: "Player" } }],
      }),
      envelope("execution.completed", { committed: true }),
    );
    await submitInteractionBlock(deps, submission);
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "ADD_MESSAGE" }),
    );
  });

  it("hands the server's refusal back to the form instead of failing the turn", async () => {
    const deps = makeDeps();
    answerWith(
      envelope("error.occurred", {
        message: "请填写“姓名”。\n总点数不对",
        code: "form_rejected",
        details: {
          issues: [
            { field: "name", message: "请填写“姓名”。" },
            { message: "总点数不对" },
          ],
        },
      }),
    );
    await expect(submitInteractionBlock(deps, submission)).resolves.toEqual({
      rejected: [
        { field: "name", message: "请填写“姓名”。" },
        { message: "总点数不对" },
      ],
    });
    // The form stays open with what the player typed: no error state, no
    // turn, and the refusal never reaches the turn's event handler.
    expect(toast).not.toHaveBeenCalled();
    expect(deps.handleSseEvent).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SUBMIT_BLOCK" }),
    );
    expect(
      vi
        .mocked(deps.dispatch)
        .mock.calls.filter(
          ([action]) => action.type === "SET_EXECUTION_ERROR" && action.error,
        ),
    ).toEqual([]);
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTING",
      value: false,
    });
    expect(deps.resyncSession).not.toHaveBeenCalled();

    // The corrected form goes out as a new request.
    answerWith(stored, envelope("execution.completed", { committed: true }));
    await submitInteractionBlock(deps, submission);
    expect(api.sendAction).toHaveBeenCalledTimes(2);
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SUBMIT_BLOCK" }),
    );
  });

  it("treats a refusal without issues as one form-level message", async () => {
    const deps = makeDeps();
    answerWith(
      envelope("error.occurred", { message: "Nope", code: "form_rejected" }),
    );
    await expect(submitInteractionBlock(deps, submission)).resolves.toEqual({
      rejected: [{ message: "Nope" }],
    });
  });

  it("watches the turn of an interaction answered elsewhere instead of sending it again", async () => {
    const deps = makeDeps();
    answerWith(
      envelope("error.occurred", {
        message: "This was already submitted. Reload to see the answer.",
        code: "interaction_already_submitted",
      }),
    );
    api.getSessionView.mockResolvedValueOnce({
      messages: [
        {
          id: "block-1",
          turnId: "turn-1",
          block: {
            type: "interactive_form",
            data: { interactionId: "form-1" },
          },
        },
      ],
      submittedInteractions: [
        {
          turnId: "turn-1",
          interactionId: "form-1",
          values: { name: "Elsewhere" },
        },
      ],
    });
    await expect(
      submitInteractionBlock(deps, submission),
    ).resolves.toBeUndefined();
    // The block takes the answer the server holds.
    await vi.waitFor(() =>
      expect(deps.dispatch).toHaveBeenCalledWith({
        type: "SUBMIT_BLOCK",
        blockId: "block-1",
        values: { name: "Elsewhere" },
      }),
    );
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_ERROR",
      error: "This was already submitted. Reload to see the answer.",
    });
    // The turn that answer started is observed through the recovery poll.
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_RECOVERY",
      recovery: {
        sessionId: "session-1",
        status: null,
        checking: true,
        hydrating: false,
      },
    });
    expect(api.sendAction).toHaveBeenCalledOnce();
    expect(deps.handleSseEvent).not.toHaveBeenCalled();
  });

  it("observes the turn after a lost connection and does not submit again", async () => {
    const deps = makeDeps();
    api.sendAction.mockImplementationOnce((_request, _onEvent, onError) => {
      onError(new TypeError("Failed to fetch"));
    });
    await expect(
      submitInteractionBlock(deps, submission),
    ).resolves.toBeUndefined();
    // Whether the server stored the answer is unknown: the read-only
    // recovery poll finds out, and the session view marks the block.
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_RECOVERY",
      recovery: {
        sessionId: "session-1",
        status: null,
        checking: true,
        hydrating: false,
      },
    });
    expect(api.sendAction).toHaveBeenCalledOnce();
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SUBMIT_BLOCK" }),
    );
    expect(deps.inFlight.size).toBe(0);
  });

  it("leaves the form as it is when the player declines the provider's code", async () => {
    const deps = makeDeps();
    api.sendAction.mockImplementationOnce((_request, _onEvent, onError) => {
      onError(
        new ApiError(
          403,
          "/api/actions",
          JSON.stringify({
            error: "Plugin action was not authorized",
            code: "plugin_approval_denied",
          }),
        ),
      );
    });
    await submitInteractionBlock(deps, submission);
    const errors = vi
      .mocked(deps.dispatch)
      .mock.calls.flatMap(([action]) =>
        action.type === "SET_EXECUTION_ERROR" ? [action.error] : [],
      );
    expect(errors.at(-1)).toBeNull();
    // A refused request started nothing to observe.
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SET_EXECUTION_RECOVERY",
        recovery: expect.anything(),
      }),
    );
    expect(deps.inFlight.size).toBe(0);
  });

  it("does not launch duplicate turns while a form request is pending", async () => {
    const deps = makeDeps();
    const pending = submitInteractionBlock(deps, submission);
    await submitInteractionBlock(deps, submission);
    expect(api.sendAction).toHaveBeenCalledOnce();
    const open = stream();
    open.onEvent(stored);
    open.onDone();
    await pending;
    expect(api.sendAction).toHaveBeenCalledOnce();
    expect(deps.inFlight.size).toBe(0);
  });

  it("does not mark a form in a new session when an old stream answers", async () => {
    const deps = makeDeps();
    const pending = submitInteractionBlock(deps, submission);
    vi.mocked(deps.dispatch).mockClear();
    deps.sessionIdRef.current = "session-2";
    const open = stream();
    open.onEvent(stored);
    open.onEvent(envelope("execution.completed", { committed: true }));
    open.onDone();
    await pending;
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.handleSseEvent).not.toHaveBeenCalled();
    expect(deps.resyncSession).not.toHaveBeenCalled();
  });

  it("does not finalize or refresh over a newer action after a slow form turn", async () => {
    const deps = makeDeps();
    const pending = submitInteractionBlock(deps, submission);
    const open = stream();
    open.onEvent(stored);
    vi.mocked(deps.dispatch).mockClear();
    deps.claimAction("session-1");
    open.onEvent(envelope("execution.completed", { committed: true }));
    open.onDone();
    await pending;
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.resyncSession).not.toHaveBeenCalled();
    expect(api.getSessionView).not.toHaveBeenCalled();
  });
});
