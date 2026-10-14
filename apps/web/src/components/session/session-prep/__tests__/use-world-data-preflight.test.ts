import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/services/api.js";
import { useWorldDataPreflight } from "../use-world-data-preflight.js";

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
