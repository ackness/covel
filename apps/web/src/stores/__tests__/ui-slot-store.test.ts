import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyUiSlotEvent,
  clearUiSlots,
  refreshUiSlots,
  useUiSlots,
} from "../ui-slot-store.js";
const request = vi.hoisted(() => vi.fn());
vi.mock("@/services/api/request.js", () => ({ request }));
const snapshot = (name: string) => ({
  slot: "stage.backdrop@1",
  value: { name, pending: false },
  revision: name,
});
beforeEach(() => {
  clearUiSlots();
  request.mockReset();
  request.mockResolvedValue({ items: [] });
});
describe("UI slot subscription state", () => {
  it("keeps previews ephemeral and rejects late preview after terminal", async () => {
    const { result } = renderHook(() => useUiSlots("s"));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    await act(async () => {
      await refreshUiSlots("s");
    });
    act(() => {
      applyUiSlotEvent("s", "ui.slot.changed", snapshot("committed"));
      applyUiSlotEvent("s", "ui.slot.preview", {
        ...snapshot("preview"),
        turnId: "t",
      });
    });
    expect(result.current[0]?.value).toMatchObject({ name: "preview" });
    act(() => {
      applyUiSlotEvent("s", "execution.completed", { turnId: "t" });
      applyUiSlotEvent("s", "ui.slot.preview", {
        ...snapshot("late"),
        turnId: "t",
      });
    });
    expect(result.current[0]?.value).toMatchObject({ name: "committed" });
    act(() => {
      applyUiSlotEvent("s", "runtime.started", { turnId: "t" });
      applyUiSlotEvent("s", "ui.slot.preview", {
        ...snapshot("retry"),
        turnId: "t",
      });
    });
    expect(result.current[0]?.value).toMatchObject({ name: "retry" });
  });
  it("does not let a late GET overwrite newer SSE and isolates sessions", async () => {
    let finish!: (value: unknown) => void;
    request.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = renderHook(() => useUiSlots("s"));
    act(() => {
      applyUiSlotEvent("s", "ui.slot.changed", snapshot("new"));
      applyUiSlotEvent("other", "ui.slot.changed", snapshot("other"));
    });
    await act(async () => {
      finish({ items: [snapshot("old")] });
      await refreshUiSlots("s");
    });
    expect(result.current[0]?.value).toMatchObject({ name: "new" });
  });
  it("does not revive cleared session state from an outstanding fetch", async () => {
    let finish!: (value: unknown) => void;
    request.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = renderHook(() => useUiSlots("s"));
    act(() => clearUiSlots("s"));
    await act(async () => {
      finish({ items: [snapshot("old")] });
    });
    expect(result.current).toEqual([]);
  });
});
