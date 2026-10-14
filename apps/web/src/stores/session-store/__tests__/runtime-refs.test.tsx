import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyUiSlotEvent,
  clearUiSlots,
  useUiSlots,
} from "@/stores/ui-slot-store.js";
import { initialState } from "../reducer.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";
import type { SessionState } from "../types.js";

vi.mock("@/services/api/request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api/request.js")>()),
  request: vi.fn(async () => ({ items: [] })),
}));
function stateForSession(id: string): SessionState {
  return { ...initialState, session: { id } as SessionState["session"] };
}
function preview(id: string) {
  applyUiSlotEvent(id, "ui.slot.preview", {
    slot: "stage.backdrop@1",
    revision: "preview",
    value: { name: "Temporary" },
    turnId: "turn",
  });
}
function setup() {
  return renderHook(
    ({ state }) => {
      const refs = useSessionRuntimeRefs(state);
      const slots = useUiSlots(state.session?.id ?? "");
      return { refs, slots };
    },
    { initialProps: { state: stateForSession("session-a") } },
  );
}
beforeEach(() => clearUiSlots());

describe("useSessionRuntimeRefs slot ownership", () => {
  it("clears a departed session's preview before revisiting it", async () => {
    const { result, rerender } = setup();
    await act(async () => {});
    act(() => preview("session-a"));
    expect(result.current.slots[0]?.previewTurnId).toBe("turn");
    await act(async () => rerender({ state: stateForSession("session-b") }));
    await act(async () => rerender({ state: stateForSession("session-a") }));
    expect(result.current.slots).toEqual([]);
  });

  it("clears slots even when navigation already cleared the active ID", async () => {
    const { result, rerender } = setup();
    await act(async () => {});
    act(() => preview("session-a"));
    result.current.refs.sessionIdRef.current = null;
    await act(async () => rerender({ state: initialState }));
    await act(async () => rerender({ state: stateForSession("session-a") }));
    expect(result.current.slots).toEqual([]);
  });

  it("clears the last session on provider unmount", async () => {
    const first = setup();
    await act(async () => {});
    act(() => preview("session-a"));
    first.unmount();
    const second = setup();
    await act(async () => {});
    expect(second.result.current.slots).toEqual([]);
  });

  it("preserves the active turn's preview on a same-session update", async () => {
    const { result, rerender } = setup();
    await act(async () => {});
    act(() => preview("session-a"));
    await act(async () => rerender({ state: stateForSession("session-a") }));
    expect(result.current.slots[0]?.previewTurnId).toBe("turn");
  });
});
