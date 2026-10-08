// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorldRecord } from "@/services/api.js";
import { useGameViewMode } from "../game-view/use-game-view-mode.js";

type World = Pick<WorldRecord, "metadata"> | null;
const stageWorld: World = { metadata: { defaultViewMode: "stage" } };

describe("game view mode", () => {
  it("opens in the world's default view", () => {
    const { result } = renderHook(() => useGameViewMode(stageWorld));
    expect(result.current[0]).toBe("stage");
  });

  it("applies the default of a world that arrives after the view mounts", () => {
    const { result, rerender } = renderHook(
      ({ world }: { world: World }) => useGameViewMode(world),
      { initialProps: { world: null as World } },
    );
    expect(result.current[0]).toBe("parsed");
    rerender({ world: stageWorld });
    expect(result.current[0]).toBe("stage");
  });

  it("keeps the view the player picked", () => {
    const { result, rerender } = renderHook(
      ({ world }: { world: World }) => useGameViewMode(world),
      { initialProps: { world: null as World } },
    );
    act(() => result.current[1]("raw"));
    rerender({ world: stageWorld });
    expect(result.current[0]).toBe("raw");

    act(() => result.current[1]("parsed"));
    rerender({ world: { metadata: { defaultViewMode: "stage", source: "x" } } });
    expect(result.current[0]).toBe("parsed");
  });
});
