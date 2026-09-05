import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitInteractionBlock } from "../interaction-submission.js";
import { claimSessionAction } from "../runtime-refs.js";

const api = vi.hoisted(() => ({
  submitInputs: vi.fn(),
  getSessionView: vi.fn(),
}));
vi.mock("@/services/api.js", () => api);

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
});

describe("interaction submission", () => {
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
