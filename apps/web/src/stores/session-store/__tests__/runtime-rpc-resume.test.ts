// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionWorkspace } from "@/services/data-service.js";
import { ApiError } from "@/services/api/request.js";

const { resumeSuspension } = vi.hoisted(() => ({ resumeSuspension: vi.fn() }));
const { emitToast } = vi.hoisted(() => ({ emitToast: vi.fn() }));
vi.mock("@/services/api", () => ({ resumeSuspension }));
vi.mock("@/lib/toast-channel.js", () => ({ emitToast }));
const { resumeSessionSuspension } = await import("../runtime-rpc.js");

function fixture() {
  const dispatch = vi.fn();
  const applyResumeEvents = vi.fn();
  const run = vi.fn((_sid: string, _id: string, mutate: () => unknown) =>
    mutate(),
  );
  const workspace = { run } as unknown as SessionWorkspace;
  const resume = () =>
    resumeSessionSuspension(
      "susp-1",
      { name: "Ada" },
      {
        workspace,
        sessionIdRef: { current: "session-1" },
        sessionGenerationRef: { current: 0 },
        dispatch,
        applyResumeEvents,
      },
    );
  return { dispatch, applyResumeEvents, resume };
}

beforeEach(() => vi.clearAllMocks());

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
