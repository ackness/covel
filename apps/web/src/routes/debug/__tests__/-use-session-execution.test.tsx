import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionExecutionStatus } from "@covel/shared";
import { useSessionExecution } from "../-use-session-execution.js";

const { getSessionExecution } = vi.hoisted(() => ({
  getSessionExecution: vi.fn(),
}));
vi.mock("@/services/api.js", () => ({ getSessionExecution }));

beforeEach(() => getSessionExecution.mockReset());
afterEach(cleanup);

describe("debugger execution status reads", () => {
  it("loads confirmed status after StrictMode effect replay", async () => {
    getSessionExecution.mockResolvedValue({
      state: "interrupted",
      turnId: "a",
    });
    const { result } = renderHook(() => useSessionExecution("session-a"), {
      wrapper: StrictMode,
    });
    await waitFor(() =>
      expect(result.current.execution?.state).toBe("interrupted"),
    );
  });

  it("ignores a delayed response after switching sessions", async () => {
    let resolveOld!: (execution: SessionExecutionStatus) => void;
    getSessionExecution
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue({ state: "running", turnId: "b" });
    const { result, rerender } = renderHook(
      ({ id }) => useSessionExecution(id),
      { initialProps: { id: "session-a" } },
    );
    rerender({ id: "session-b" });
    await waitFor(() => expect(result.current.execution?.turnId).toBe("b"));
    await act(async () => resolveOld({ state: "interrupted", turnId: "a" }));
    expect(result.current.execution).toEqual({ state: "running", turnId: "b" });
  });

  it("coalesces slow status reads and accepts their eventual result", async () => {
    let resolve!: (execution: SessionExecutionStatus) => void;
    getSessionExecution.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = renderHook(() => useSessionExecution("session-a"));
    await act(async () => {
      await Promise.all([
        result.current.refreshExecution(),
        result.current.refreshExecution(),
      ]);
    });
    expect(getSessionExecution).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ state: "interrupted", turnId: "a" }));
    expect(result.current.execution?.state).toBe("interrupted");
  });

  it("retains confirmed status on read failure and recovers on refresh", async () => {
    getSessionExecution.mockResolvedValue({ state: "running", turnId: "a" });
    const { result } = renderHook(() => useSessionExecution("session-a"));
    await waitFor(() =>
      expect(result.current.execution?.state).toBe("running"),
    );
    getSessionExecution.mockRejectedValueOnce(new Error("offline"));
    await act(async () => result.current.refreshExecution());
    expect(result.current.execution?.state).toBe("running");
    getSessionExecution.mockResolvedValue({
      state: "interrupted",
      turnId: "a",
    });
    await act(async () => result.current.refreshExecution());
    expect(result.current.execution?.state).toBe("interrupted");
  });
});
