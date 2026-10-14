import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emitToast } from "@/lib/toast-channel.js";
import { ToastHost } from "../toast-host.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("pauses until both keyboard focus and hover leave the notification", () => {
  vi.useFakeTimers();
  render(<ToastHost />);
  act(() => emitToast("error", "Read this error", "Details"));
  const toast = screen.getByRole("alert");
  const [copy, dismiss] = screen.getAllByRole("button");
  if (!copy || !dismiss) throw new Error("Missing toast controls");
  act(() => copy.focus());
  act(() => vi.advanceTimersByTime(7000));
  expect(screen.getByRole("alert")).toBe(toast);
  fireEvent.mouseEnter(toast);
  act(() => dismiss.focus());
  fireEvent.mouseLeave(toast);
  act(() => vi.advanceTimersByTime(7000));
  expect(screen.getByRole("alert")).toBe(toast);
  fireEvent.mouseEnter(toast);
  act(() => dismiss.blur());
  act(() => vi.advanceTimersByTime(7000));
  expect(screen.getByRole("alert")).toBe(toast);
  fireEvent.mouseLeave(toast);
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole("alert")).toBeNull();
});
