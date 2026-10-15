import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/services/api.js";
import { ApiError } from "@/services/api/request.js";
import {
  dimensionProviderCandidates,
  useWorldDataPreflight,
} from "../use-world-data-preflight.js";

vi.mock("@/services/api.js", () => ({ preflightWorldData: vi.fn() }));
const prepare = async () => {};
function deferred() {
  let resolve!: (value: api.WorldDataPreflightResponse) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<api.WorldDataPreflightResponse>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const resultFor = (planned: number): api.WorldDataPreflightResponse => ({
  planned,
  imported: false,
  targets: [],
  diagnostics: [],
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("preflight request ownership", () => {
  it.each(["success", "failure"])(
    "ignores an older %s after newer diagnostics arrive",
    async (outcome) => {
      const old = deferred();
      const latest = deferred();
      vi.mocked(api.preflightWorldData)
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(latest.promise);
      const { result, rerender } = renderHook(
        ({ ids }) => useWorldDataPreflight("world", ids, prepare),
        {
          initialProps: { ids: ["first"] },
        },
      );
      await act(async () => vi.advanceTimersByTimeAsync(250));
      rerender({ ids: ["second"] });
      await act(async () => vi.advanceTimersByTimeAsync(250));
      const current = resultFor(2);
      await act(async () => latest.resolve(current));
      await act(async () =>
        outcome === "success"
          ? old.resolve(resultFor(1))
          : old.reject(new Error("stale")),
      );
      expect(result.current.worldDataPreflight).toEqual(current);
      expect(result.current.worldDataPreflightStatus).toBe("success");
      expect(result.current.worldDataPreflightError).toBeNull();
    },
  );

  it("names the dimension providers the server asks the player to choose from", async () => {
    vi.mocked(api.preflightWorldData).mockRejectedValueOnce(
      new ApiError(
        409,
        "/api/worlds/world/world-data/preflight",
        JSON.stringify({
          error: "Several plugins keep world dimensions (a, b).",
          code: "dimension_provider_conflict",
          details: { candidates: ["a", "b"] },
        }),
      ),
    );
    vi.mocked(api.preflightWorldData).mockResolvedValueOnce(resultFor(1));
    const { result, rerender } = renderHook(
      ({ ids }) => useWorldDataPreflight("world", ids, prepare),
      { initialProps: { ids: ["a", "b"] } },
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(result.current.dimensionProviderConflict).toEqual(["a", "b"]);
    expect(result.current.worldDataPreflightStatus).toBe("error");

    // Keeping one clears the choice with the next check.
    rerender({ ids: ["a"] });
    expect(result.current.dimensionProviderConflict).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(result.current.dimensionProviderConflict).toBeNull();
    expect(result.current.worldDataPreflightStatus).toBe("success");
  });

  it("asks for no choice on any other failure", () => {
    expect(dimensionProviderCandidates(new Error("offline"))).toBeNull();
    expect(
      dimensionProviderCandidates(
        new ApiError(409, "/x", JSON.stringify({ error: "x", code: "other" })),
      ),
    ).toBeNull();
  });

  it("invalidates a request during the debounce for a changed world", async () => {
    const old = deferred();
    vi.mocked(api.preflightWorldData).mockReturnValueOnce(old.promise);
    const ids = ["plugin"];
    const { result, rerender } = renderHook(
      ({ worldId }) => useWorldDataPreflight(worldId, ids, prepare),
      {
        initialProps: { worldId: "first" },
      },
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    rerender({ worldId: "second" });
    await act(async () => old.resolve(resultFor(1)));
    expect(result.current.worldDataPreflight).toBeNull();
    expect(result.current.worldDataPreflightStatus).not.toBe("success");
  });
});
