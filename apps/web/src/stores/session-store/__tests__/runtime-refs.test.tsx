import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __clearDomainEventPreviewsForTest,
  applyDomainEventPreview,
  getDomainEventPreview,
} from "@/stores/domain-event-preview-store.js";
import { initialState } from "../reducer.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";
import type { SessionState } from "../types.js";

function stateForSession(id: string): SessionState {
  return {
    ...initialState,
    session: { id } as SessionState["session"],
  };
}

describe("useSessionRuntimeRefs", () => {
  beforeEach(() => __clearDomainEventPreviewsForTest());

  it("clears speculative presentation state when leaving a session", () => {
    applyDomainEventPreview("session-a", {
      turnId: "turn-1",
      topic: "stage.direction",
      data: { cues: [{ type: "stage.clear" }] },
    });
    const { rerender } = renderHook(
      ({ state }) => useSessionRuntimeRefs(state),
      { initialProps: { state: stateForSession("session-a") } },
    );

    expect(getDomainEventPreview("session-a", "stage.direction")).toBeDefined();
    act(() => rerender({ state: stateForSession("session-b") }));

    expect(
      getDomainEventPreview("session-a", "stage.direction"),
    ).toBeUndefined();
  });

  it("clears previews even when navigation already cleared the active id", () => {
    const { result, rerender } = renderHook(
      ({ state }) => useSessionRuntimeRefs(state),
      { initialProps: { state: stateForSession("session-a") } },
    );
    applyDomainEventPreview("session-a", {
      turnId: "turn-1",
      topic: "stage.direction",
      data: { cues: [] },
    });
    result.current.sessionIdRef.current = null;
    act(() => rerender({ state: initialState }));
    expect(
      getDomainEventPreview("session-a", "stage.direction"),
    ).toBeUndefined();
  });
});
