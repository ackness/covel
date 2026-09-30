import { beforeEach, expect, it, vi } from "vitest";
import { createSessionWorkspace } from "@/services/data-service/workspace.js";
import type { DataService } from "@/services/data-service.js";
import { resolveSetupRuntime } from "../setup-recovery-actions.js";

const api = vi.hoisted(() => ({
  retrySetupRuntime: vi.fn(),
  waiveSetupRuntime: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock("@/services/api", () => api);

beforeEach(() => {
  vi.resetAllMocks();
  api.retrySetupRuntime.mockResolvedValue({ ok: true });
  api.waiveSetupRuntime.mockResolvedValue({ ok: true });
  api.getSession.mockResolvedValue({ id: "session", setupRuntimes: {} });
});

it.each(["retry", "waive"] as const)(
  "publishes the global session after remote %s without mirror calls",
  async (resolution) => {
    const dispatch = vi.fn();
    const service = { withSessionWorkspace: vi.fn() } as unknown as DataService;
    await resolveSetupRuntime("guide/setup", resolution, {
      workspace: createSessionWorkspace(service, "remote"),
      sessionIdRef: { current: "session" },
      sessionGenerationRef: { current: 1 },
      dispatch,
    });
    const recover =
      resolution === "retry" ? api.retrySetupRuntime : api.waiveSetupRuntime;
    expect(recover).toHaveBeenCalledExactlyOnceWith("session", "guide/setup");
    expect(service.withSessionWorkspace).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_SESSION",
      session: { id: "session", setupRuntimes: {} },
    });
  },
);

it("leaves a failed recovery retryable and does not publish a session", async () => {
  const dispatch = vi.fn();
  api.retrySetupRuntime.mockRejectedValueOnce(new Error("offline"));
  const options = {
    workspace: createSessionWorkspace({} as DataService, "remote"),
    sessionIdRef: { current: "session" },
    sessionGenerationRef: { current: 1 },
    dispatch,
  };
  await expect(
    resolveSetupRuntime("guide/setup", "retry", options),
  ).rejects.toThrow("offline");
  expect(dispatch).not.toHaveBeenCalled();
  await resolveSetupRuntime("guide/setup", "retry", options);
  expect(dispatch).toHaveBeenCalledOnce();
});

it("does not publish a previous visit's recovery into the current session", async () => {
  const dispatch = vi.fn();
  const generation = { current: 1 };
  let finish!: (value: unknown) => void;
  api.getSession.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const recovery = resolveSetupRuntime("guide/setup", "waive", {
    workspace: createSessionWorkspace({} as DataService, "remote"),
    sessionIdRef: { current: "session" },
    sessionGenerationRef: generation,
    dispatch,
  });
  await vi.waitFor(() => expect(api.getSession).toHaveBeenCalledOnce());
  generation.current += 1;
  finish({ id: "session" });
  await recovery;
  expect(dispatch).not.toHaveBeenCalled();
});
