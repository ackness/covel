import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { UiSlotSnapshot } from "@covel/shared";
import { useStageMediaPreload } from "../use-stage-media-preload.js";
const mocks = vi.hoisted(() => ({
  slots: [] as UiSlotSnapshot[],
  resolve: vi.fn(
    async (_ref: { id: string }, _options: { sessionId: string }) => ({
      url: "data:image/png;base64,",
      ok: true,
    }),
  ),
}));
vi.mock("@/stores/ui-slot-store.js", () => ({ useUiSlots: () => mocks.slots }));
vi.mock("@/lib/media-resolve.js", () => ({ resolveMediaSrc: mocks.resolve }));
const ref = (id: string, mime = "image/png") => ({ id, mime, size: 1 });
beforeEach(() => {
  mocks.resolve.mockClear();
  mocks.slots = [];
});
describe("useStageMediaPreload", () => {
  it("warms all projected visual variants and registry backdrops once per session", async () => {
    mocks.slots = [
      {
        slot: "character.visual@1",
        key: "hero",
        revision: "1",
        value: {
          characterId: "hero",
          avatar: ref("avatar"),
          sprite: ref("sprite"),
          visuals: { variants: [{ id: "night", sprite: ref("night") }] },
        },
      },
      {
        slot: "stage.backdrop@1",
        revision: "1",
        value: {
          ref: ref("gate"),
          preload: [ref("gate"), ref("hall"), ref("audio", "audio/wav")],
        },
      },
    ];
    const { rerender } = renderHook(
      ({ sessionId }) => useStageMediaPreload(sessionId),
      { initialProps: { sessionId: "s1" } },
    );
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(5));
    expect(mocks.resolve.mock.calls.map(([r]) => r.id).sort()).toEqual([
      "avatar",
      "gate",
      "hall",
      "night",
      "sprite",
    ]);
    rerender({ sessionId: "s1" });
    expect(mocks.resolve).toHaveBeenCalledTimes(5);
    rerender({ sessionId: "s2" });
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(10));
  });
  it("does not warm imagery without projections", () => {
    renderHook(() => useStageMediaPreload("s1"));
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
