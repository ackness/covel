// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { importWithRetry } from "../lazy-with-retry.js";

const chunkFailure = () =>
  new TypeError(
    "Failed to fetch dynamically imported module: http://127.0.0.1/assets/game-view.js",
  );
const noWait = vi.fn(async () => {});

describe("importWithRetry", () => {
  it("loads again after a failed chunk download", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(chunkFailure())
      .mockResolvedValueOnce("module");

    await expect(importWithRetry(load, [500, 1500], noWait)).resolves.toBe(
      "module",
    );
    expect(load).toHaveBeenCalledTimes(2);
    expect(noWait).toHaveBeenLastCalledWith(500);
  });

  it("gives up after the last retry with the original error", async () => {
    const failure = chunkFailure();
    const load = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
    const wait = vi.fn(async () => {});

    await expect(importWithRetry(load, [500, 1500], wait)).rejects.toBe(
      failure,
    );
    expect(load).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[500], [1500]]);
  });

  it.each([
    ["Firefox", "error loading dynamically imported module: /a.js"],
    ["Safari", "Importing a module script failed."],
  ])("recognises a %s download failure", async (_browser, message) => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError(message))
      .mockResolvedValueOnce("module");
    await expect(importWithRetry(load, [1], noWait)).resolves.toBe("module");
  });

  it("does not retry an error the module itself throws", async () => {
    const failure = new Error("module evaluation failed");
    const load = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    await expect(importWithRetry(load, [500], noWait)).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
