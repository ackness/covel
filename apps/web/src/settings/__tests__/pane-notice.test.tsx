import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePaneNotice } from "../pane-notice.js";

afterEach(() => vi.useRealTimers());
it("F-090 gives the newest result its own lifetime and clears timers on unmount", () => {
  vi.useFakeTimers();
  const { result, unmount } = renderHook(usePaneNotice);
  act(() => result.current.show({ tone: "success", message: "first" }, 3000));
  act(() => vi.advanceTimersByTime(2000));
  act(() => result.current.show({ tone: "error", message: "second" }, 5000));
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current.notice?.message).toBe("second");
  act(() => vi.advanceTimersByTime(4000));
  expect(result.current.notice).toBeNull();
  act(() => result.current.show({ tone: "success", message: "third" }));
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
