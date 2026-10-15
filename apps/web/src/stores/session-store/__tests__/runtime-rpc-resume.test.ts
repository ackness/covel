// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionWorkspace } from "@/services/data-service.js";
import { ApiError } from "@/services/api/request.js";

const {
  resumeSuspension,
  resolveApproval,
  listSessionPlugins,
  requestConfirm,
} = vi.hoisted(() => ({
  resumeSuspension: vi.fn(),
  resolveApproval: vi.fn(),
  listSessionPlugins: vi.fn(),
  requestConfirm: vi.fn(),
}));
const { emitToast } = vi.hoisted(() => ({ emitToast: vi.fn() }));
vi.mock("@/services/api", () => ({
  resumeSuspension,
  resolveApproval,
  listSessionPlugins,
}));
vi.mock("@/lib/confirm-channel.js", () => ({ requestConfirm }));
vi.mock("@/lib/toast-channel.js", () => ({ emitToast }));
const { resumeSessionSuspension } = await import("../runtime-rpc.js");

function fixture() {
  const dispatch = vi.fn();
  const applyResumeEvents = vi.fn();
  let inWorkspace = false;
  const run = vi.fn(
    async (_sid: string, _id: string, mutate: () => unknown) => {
      inWorkspace = true;
      try {
        return await mutate();
      } finally {
        inWorkspace = false;
      }
    },
  );
  const sessionIdRef = { current: "session-1" };
  const sessionGenerationRef = { current: 0 };
  const workspace = { run } as unknown as SessionWorkspace;
  const resume = () =>
    resumeSessionSuspension(
      "susp-1",
      { name: "Ada" },
      {
        workspace,
        sessionIdRef,
        sessionGenerationRef,
        dispatch,
        applyResumeEvents,
      },
    );
  return {
    dispatch,
    applyResumeEvents,
    resume,
    sessionIdRef,
    sessionGenerationRef,
    inWorkspace: () => inWorkspace,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  resolveApproval.mockResolvedValue({ ok: true });
  listSessionPlugins.mockResolvedValue({ items: [], commands: [] });
  requestConfirm.mockResolvedValue(true);
});

describe("resuming an out-of-date suspension", () => {
  it("removes the withdrawn suspension and tells the player why", async () => {
    resumeSuspension.mockRejectedValue(
      new ApiError(
        409,
        "/api/sessions/session-1/suspensions/susp-1/resume",
        JSON.stringify({
          error: "This request is out of date.",
          code: "suspension_outdated",
          details: { reason: "plugin-updated" },
        }),
      ),
    );
    const { dispatch, applyResumeEvents, resume } = fixture();

    await resume();

    expect(dispatch).toHaveBeenCalledWith({
      type: "REMOVE_SUSPENSION",
      suspensionId: "susp-1",
    });
    expect(applyResumeEvents).not.toHaveBeenCalled();
    expect(emitToast).toHaveBeenCalledWith(
      "info",
      expect.any(String),
      // The test setup runs the UI in Simplified Chinese.
      "提出它的插件之后更新过。",
    );
  });

  it("says when what it would change was changed since it was asked", async () => {
    resumeSuspension.mockRejectedValue(
      new ApiError(
        409,
        "/api/sessions/session-1/suspensions/susp-1/resume",
        JSON.stringify({
          error: "This request is out of date.",
          code: "suspension_outdated",
          details: { reason: "data-changed" },
        }),
      ),
    );
    const { dispatch, resume } = fixture();

    await resume();

    expect(dispatch).toHaveBeenCalledWith({
      type: "REMOVE_SUSPENSION",
      suspensionId: "susp-1",
    });
    expect(emitToast).toHaveBeenCalledWith(
      "info",
      expect.any(String),
      "提出它之后，它要改的内容已经被改过了。",
    );
  });

  it("still fails a resume the server rejected for another reason", async () => {
    resumeSuspension.mockRejectedValue(
      new ApiError(
        409,
        "/api/sessions/session-1/suspensions/susp-1/resume",
        JSON.stringify({ error: "Suspension already resolved" }),
      ),
    );
    const { dispatch, resume } = fixture();

    await expect(resume()).rejects.toBeInstanceOf(ApiError);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

function approval(action: string, sessionId = "session-1") {
  return {
    status: "approval-required",
    approvalId: `approval:${action}`,
    pending: { sessionId, pluginId: "external", action },
  };
}
const completed = {
  result: {
    runtimeId: "external/run",
    pluginId: "external",
    status: "success",
    turnId: "turn-1",
  },
  events: [],
};

describe("resuming with missing approval", () => {
  it("asks outside the workspace queue and retries after each grant", async () => {
    const state = fixture();
    requestConfirm.mockImplementation(async () => {
      expect(state.inWorkspace()).toBe(false);
      return true;
    });
    resumeSuspension
      .mockResolvedValueOnce(approval("covel:plugin-server-code"))
      .mockResolvedValueOnce(approval("runtime:external/run"))
      .mockResolvedValueOnce(completed);
    await state.resume();
    expect(requestConfirm).toHaveBeenCalledTimes(2);
    expect(resolveApproval.mock.calls).toEqual([
      ["approval:covel:plugin-server-code", "allow", "session", "session-1"],
      ["approval:runtime:external/run", "allow", "session", "session-1"],
    ]);
    expect(resumeSuspension.mock.calls).toEqual(
      Array(3).fill(["session-1", "susp-1", { name: "Ada" }]),
    );
    expect(state.applyResumeEvents).toHaveBeenCalledWith([]);
    expect(state.dispatch).toHaveBeenCalledWith({
      type: "REMOVE_SUSPENSION",
      suspensionId: "susp-1",
    });
  });

  it("retains the suspension when the player denies approval", async () => {
    resumeSuspension.mockResolvedValue(approval("runtime:external/run"));
    requestConfirm.mockResolvedValue(false);
    const state = fixture();
    await state.resume();
    expect(resolveApproval).toHaveBeenCalledWith(
      "approval:runtime:external/run",
      "deny",
      "session",
      "session-1",
    );
    expect(resumeSuspension).toHaveBeenCalledOnce();
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.applyResumeEvents).not.toHaveBeenCalled();
  });

  it("denies the captured session's approval if the session changes during the dialog", async () => {
    resumeSuspension.mockResolvedValue(approval("runtime:external/run"));
    const state = fixture();
    requestConfirm.mockImplementation(async () => {
      state.sessionIdRef.current = "session-2";
      state.sessionGenerationRef.current++;
      return true;
    });
    await state.resume();
    expect(resolveApproval).toHaveBeenCalledWith(
      "approval:runtime:external/run",
      "deny",
      "session",
      "session-1",
    );
    expect(resumeSuspension).toHaveBeenCalledOnce();
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("stops repeated requests for the same grant", async () => {
    resumeSuspension.mockResolvedValue(approval("runtime:external/run"));
    await expect(fixture().resume()).rejects.toThrow();
    expect(resumeSuspension).toHaveBeenCalledTimes(2);
    expect(requestConfirm).toHaveBeenCalledOnce();
    expect(resolveApproval).toHaveBeenCalledOnce();
  });

  it("rejects an approval for another session", async () => {
    resumeSuspension.mockResolvedValue(
      approval("runtime:external/run", "session-2"),
    );
    await expect(fixture().resume()).rejects.toThrow();
    expect(requestConfirm).not.toHaveBeenCalled();
    expect(resolveApproval).not.toHaveBeenCalled();
  });
});
