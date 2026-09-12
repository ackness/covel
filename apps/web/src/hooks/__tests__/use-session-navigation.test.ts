import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { useSessionNavigation } from "../use-session-navigation.js";

function setup(sid?: string, sessionId?: string) {
  const actions = {
    resumeSessionById: vi.fn(async (_id: string) => {}),
    backToWorldSelect: vi.fn(),
    replaceSessionUrl: vi.fn(),
  };
  const props = { sid, sessionId, booted: true, hasRecovery: false };
  return {
    ...renderHook((value) => useSessionNavigation({ ...value, ...actions }), {
      initialProps: props,
      wrapper: StrictMode,
    }),
    actions,
    props,
  };
}

it("restores a URL target instead of rewriting it to a previously open session", () => {
  const { actions } = setup("session-b", "session-a");
  expect(actions.resumeSessionById).toHaveBeenCalledExactlyOnceWith(
    "session-b",
  );
  expect(actions.replaceSessionUrl).not.toHaveBeenCalled();
});
it("follows URL changes and preserves the target throughout hydration", () => {
  const { actions, props, rerender } = setup("session-a", "session-a");
  rerender({ ...props, sid: "session-b" });
  expect(actions.resumeSessionById).toHaveBeenCalledExactlyOnceWith(
    "session-b",
  );
  rerender({
    ...props,
    sid: "session-b",
    sessionId: undefined,
    hasRecovery: true,
  });
  rerender({ ...props, sid: "session-b", sessionId: "session-b" });
  expect(actions.replaceSessionUrl).not.toHaveBeenCalled();
});
it("updates the URL for a session created or selected inside Studio", () => {
  const { actions, props, rerender } = setup();
  rerender({ ...props, sessionId: "created-session" });
  expect(actions.replaceSessionUrl).toHaveBeenCalledWith("created-session");
  expect(actions.resumeSessionById).not.toHaveBeenCalled();
});
it("returns to world selection when browser navigation removes sid", () => {
  const { actions, props, rerender } = setup("session-a", "session-a");
  rerender({ ...props, sid: undefined });
  expect(actions.backToWorldSelect).toHaveBeenCalledOnce();
  expect(actions.replaceSessionUrl).not.toHaveBeenCalled();
});
it("surfaces initial read failures and allows a retry without dropping the URL", async () => {
  const { actions, props, result, rerender } = setup();
  actions.resumeSessionById.mockRejectedValueOnce(new Error("offline"));
  rerender({ ...props, sid: "session-a" });
  await waitFor(() => expect(result.current.error).toBe("offline"));
  expect(actions.replaceSessionUrl).not.toHaveBeenCalled();
  act(() => result.current.retry());
  expect(result.current.error).toBeNull();
  expect(actions.resumeSessionById).toHaveBeenCalledTimes(2);
});
it("ignores failures from an abandoned target", async () => {
  const { actions, props, result, rerender } = setup();
  let reject!: (error: Error) => void;
  actions.resumeSessionById.mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  rerender({ ...props, sid: "session-a" });
  rerender({ ...props, sid: "session-b" });
  await act(async () => {
    reject(new Error("Session not found: session-a"));
  });
  expect(actions.replaceSessionUrl).not.toHaveBeenCalled();
  expect(result.current.error).toBeNull();
});

it("updates the URL when an in-Studio switch publishes its hydrated session before recovery finishes", () => {
  const { actions, props, rerender } = setup("session-a", "session-a");
  rerender({ ...props, sessionId: undefined, hasRecovery: true });
  expect(actions.replaceSessionUrl).not.toHaveBeenCalled();
  rerender({ ...props, sessionId: "session-b", hasRecovery: true });
  expect(actions.replaceSessionUrl).toHaveBeenCalledWith("session-b");
});
