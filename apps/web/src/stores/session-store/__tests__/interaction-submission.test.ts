import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitInteractionBlock } from "../interaction-submission.js";
import { claimSessionAction } from "../runtime-refs.js";

const api = vi.hoisted(() => ({
  submitInputs: vi.fn(),
  getSessionView: vi.fn(),
  resolveApproval: vi.fn(),
  listSessionPlugins: vi.fn(),
}));
vi.mock("@/services/api.js", () => api);
const confirm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/confirm-channel.js", () => ({ requestConfirm: confirm }));

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
    claimAction: (sid) =>
      claimSessionAction(activeActionRef, sessionIdRef, sid),
    submitBlock: vi.fn(),
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
    expect(deps.submitBlock).not.toHaveBeenCalled();
    expect(deps.runSingleAction).not.toHaveBeenCalled();
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
      expect(deps.submitBlock).toHaveBeenCalledTimes(
        decision === "allow" ? 1 : 0,
      );
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
    expect(deps.submitBlock).not.toHaveBeenCalled();
    expect(deps.runSingleAction).not.toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_ERROR",
      error: "Invalid character field",
    });
    await submitInteractionBlock(deps, submission);
    expect(deps.submitBlock).toHaveBeenCalledWith("block-1", {
      name: "Player",
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
    expect(deps.submitBlock).not.toHaveBeenCalled();
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
    expect(deps.submitBlock).not.toHaveBeenCalled();
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
