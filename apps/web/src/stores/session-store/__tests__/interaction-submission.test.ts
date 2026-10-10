// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitInteractionBlock } from "../interaction-submission.js";
import { claimSessionAction } from "../runtime-refs.js";
import { initialState } from "../reducer.js";
import { ApiError } from "@/services/api/request.js";

const api = vi.hoisted(() => ({
  submitInputs: vi.fn(),
  getSessionView: vi.fn(),
  resolveApproval: vi.fn(),
  listSessionPlugins: vi.fn(),
}));
vi.mock("@/services/api.js", () => api);
const confirm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/confirm-channel.js", () => ({ requestConfirm: confirm }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast-channel.js", () => ({ emitToast: toast }));

const accepted = {
  results: [
    {
      submissionId: "input-1",
      interactionId: "form-1",
      filledNarrative: "Ready",
      accepted: true,
    },
  ],
};
const submission: Parameters<typeof submitInteractionBlock>[1] = [
  "block-1",
  "turn-1",
  "form-1",
  "form",
  { name: "Player" },
];

function makeDeps(): Parameters<typeof submitInteractionBlock>[0] {
  const sessionIdRef = { current: "session-1" };
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
    runSingleAction: vi.fn(async () => {}),
    resyncSession: vi.fn(),
    inFlight: new Set(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.submitInputs.mockResolvedValue(accepted);
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
    expect(api.submitInputs).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
  it("refreshes authorization even when the restored form then fails validation", async () => {
    const deps = makeDeps();
    confirm.mockResolvedValue(true);
    api.submitInputs.mockImplementationOnce(
      async (_sid, _body, resolveResponse) => {
        return resolveResponse(
          {
            status: "approval-required",
            approvalId: "restored-form",
            pending: {
              sessionId: "session-1",
              pluginId: "provider",
              action: "covel:plugin-server-code",
            },
          },
          async () => {
            throw new Error("Invalid allocation");
          },
        );
      },
    );
    await submitInteractionBlock(deps, submission);
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "LOAD_SESSION_PLUGINS",
      plugins: [],
      commands: [],
    });
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_ERROR",
      error: "Invalid allocation",
    });
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SUBMIT_BLOCK" }),
    );
    expect(deps.runSingleAction).not.toHaveBeenCalled();
  });

  it("hands the server's refusal back to the form instead of failing the turn", async () => {
    const deps = makeDeps();
    api.submitInputs.mockRejectedValueOnce(
      new ApiError(
        400,
        "/api/sessions/session-1/plugin-rpc",
        JSON.stringify({
          error: "请填写“姓名”。\n总点数不对",
          code: "form_rejected",
          details: {
            issues: [
              { field: "name", message: "请填写“姓名”。" },
              { message: "总点数不对" },
            ],
          },
        }),
      ),
    );
    await expect(submitInteractionBlock(deps, submission)).resolves.toEqual({
      rejected: [
        { field: "name", message: "请填写“姓名”。" },
        { message: "总点数不对" },
      ],
    });
    // The form stays open with what the player typed: no error state, no turn.
    expect(toast).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SUBMIT_BLOCK" }),
    );
    expect(deps.runSingleAction).not.toHaveBeenCalled();
  });

  it("shows an interaction answered in another tab as answered and reloads the stored answer", async () => {
    const deps = makeDeps();
    api.submitInputs.mockRejectedValueOnce(
      new ApiError(
        400,
        "/api/sessions/session-1/plugin-rpc",
        JSON.stringify({
          error: "This was already submitted. Reload to see the answer.",
          code: "interaction_already_submitted",
        }),
      ),
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
    expect(deps.runSingleAction).not.toHaveBeenCalled();
  });

  it("treats a refusal without issues as one form-level message", async () => {
    const deps = makeDeps();
    api.submitInputs.mockRejectedValueOnce(
      new ApiError(
        400,
        "/api/sessions/session-1/plugin-rpc",
        JSON.stringify({ error: "Nope", code: "form_rejected" }),
      ),
    );
    await expect(submitInteractionBlock(deps, submission)).resolves.toEqual({
      rejected: [{ message: "Nope" }],
    });
  });

  it.each(["allow", "deny", "switch"])(
    "keeps restored-form authorization tied to its session: %s",
    async (decision) => {
      const deps = makeDeps();
      confirm.mockImplementation(async () => {
        if (decision === "switch") deps.sessionIdRef.current = "session-2";
        return decision !== "deny";
      });
      const retry = vi.fn(async () => ({ status: "ok", result: accepted }));
      api.submitInputs.mockImplementationOnce(
        async (_sid, _body, resolveResponse) => {
          const response = await resolveResponse(
            {
              status: "approval-required",
              approvalId: "restored-form",
              pending: {
                sessionId: "session-1",
                pluginId: "provider",
                action: "covel:plugin-server-code",
              },
            },
            retry,
          );
          return response?.result ?? null;
        },
      );
      await submitInteractionBlock(deps, submission);
      expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith(
        "restored-form",
        decision === "allow" ? "allow" : "deny",
        "session",
        "session-1",
      );
      expect(retry).toHaveBeenCalledTimes(decision === "allow" ? 1 : 0);
      expect(
        vi
          .mocked(deps.dispatch)
          .mock.calls.filter(([action]) => action.type === "SUBMIT_BLOCK"),
      ).toHaveLength(decision === "allow" ? 1 : 0);
      expect(deps.runSingleAction).toHaveBeenCalledTimes(
        decision === "allow" ? 1 : 0,
      );
      if (decision !== "allow") expect(deps.dispatch).not.toHaveBeenCalled();
      else
        expect(deps.dispatch).toHaveBeenCalledWith({
          type: "LOAD_SESSION_PLUGINS",
          plugins: [],
          commands: [],
        });
    },
  );

  it("keeps a rejected form editable and never converts invalid input into a story", async () => {
    api.submitInputs.mockRejectedValueOnce(
      new Error("Invalid character field"),
    );
    const deps = makeDeps();
    await submitInteractionBlock(deps, submission);
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SUBMIT_BLOCK" }),
    );
    expect(deps.runSingleAction).not.toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_ERROR",
      error: "Invalid character field",
    });
    await submitInteractionBlock(deps, submission);
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "SUBMIT_BLOCK",
      blockId: "block-1",
      values: { name: "Player" },
    });
    expect(deps.runSingleAction).toHaveBeenCalledExactlyOnceWith("Ready", {
      echoUserMessage: true,
      owner: expect.objectContaining({ requestId: expect.any(String) }),
    });
  });

  it("does not launch duplicate turns while a form request is pending", async () => {
    let resolve!: (value: typeof accepted) => void;
    api.submitInputs.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const deps = makeDeps();
    const pending = submitInteractionBlock(deps, submission);
    await submitInteractionBlock(deps, submission);
    expect(api.submitInputs).toHaveBeenCalledOnce();
    resolve(accepted);
    await pending;
    expect(deps.runSingleAction).toHaveBeenCalledOnce();
    expect(deps.inFlight.size).toBe(0);
  });

  it("does not mark a form in a new session when an old response arrives", async () => {
    let resolve!: (value: typeof accepted) => void;
    api.submitInputs.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const deps = makeDeps();
    const pending = submitInteractionBlock(deps, submission);
    deps.sessionIdRef.current = "session-2";
    resolve(accepted);
    await pending;
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SUBMIT_BLOCK" }),
    );
    expect(deps.runSingleAction).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("ignores an old form response after another action starts in the same session", async () => {
    let resolve!: (value: typeof accepted) => void;
    api.submitInputs.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const deps = makeDeps();
    const pending = submitInteractionBlock(deps, submission);
    deps.claimAction("session-1");
    resolve(accepted);
    await pending;
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SUBMIT_BLOCK" }),
    );
    expect(deps.runSingleAction).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("does not finalize or refresh over a newer action after a slow form turn", async () => {
    let finish!: () => void;
    const deps = makeDeps();
    vi.mocked(deps.runSingleAction).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = submitInteractionBlock(deps, submission);
    await vi.waitFor(() => expect(deps.runSingleAction).toHaveBeenCalledOnce());
    vi.mocked(deps.dispatch).mockClear();
    deps.claimAction("session-1");
    finish();
    await pending;
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.resyncSession).not.toHaveBeenCalled();
    expect(api.getSessionView).not.toHaveBeenCalled();
  });
});
