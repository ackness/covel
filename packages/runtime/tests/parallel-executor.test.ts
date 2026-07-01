import { describe, it, expect, vi } from "vitest";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import { executeParallel } from "../src/schedule/parallel-executor.js";

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return { name: "test-rt", description: "test", priority: 500, ...overrides };
}

function makeResult(overrides?: Partial<RuntimeResult>): RuntimeResult {
  return {
    pluginId: "test",
    runtimeId: "test-rt",
    runId: "run-1",
    turnId: "turn-1",
    status: "success",
    output: {},
    toolCalls: [],
    durationMs: 100,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── executeParallel ─────────────────────────────────────────────

describe("executeParallel", () => {
  // 1. Single runtime
  it("should return a map with 1 entry for a single runtime", async () => {
    const rt = makeManifest({ name: "alpha" });
    const result = makeResult({ runtimeId: "alpha" });
    const executeFn = vi.fn().mockResolvedValue(result);

    const map = await executeParallel([rt], executeFn);

    expect(map.size).toBe(1);
    expect(map.get("alpha")).toEqual(result);
  });

  // 2. Multiple parallel — all succeed
  it("should return a map with 3 entries when 3 runtimes all succeed", async () => {
    const runtimes = [
      makeManifest({ name: "a" }),
      makeManifest({ name: "b" }),
      makeManifest({ name: "c" }),
    ];
    const executeFn = vi
      .fn()
      .mockImplementation((rt: RuntimeManifest) =>
        Promise.resolve(makeResult({ runtimeId: rt.name })),
      );

    const map = await executeParallel(runtimes, executeFn);

    expect(map.size).toBe(3);
    expect(map.get("a")?.status).toBe("success");
    expect(map.get("b")?.status).toBe("success");
    expect(map.get("c")?.status).toBe("success");
  });

  // 3. One fails, others succeed (Promise.allSettled)
  it("should mark failed runtime as failed while others succeed", async () => {
    const runtimes = [
      makeManifest({ name: "a" }),
      makeManifest({ name: "b" }),
      makeManifest({ name: "c" }),
    ];
    const executeFn = vi.fn().mockImplementation((rt: RuntimeManifest) => {
      if (rt.name === "b") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve(makeResult({ runtimeId: rt.name }));
    });

    const map = await executeParallel(runtimes, executeFn);

    expect(map.size).toBe(3);
    expect(map.get("a")?.status).toBe("success");
    expect(map.get("b")?.status).toBe("failed");
    expect(map.get("b")?.error).toBe("boom");
    expect(map.get("c")?.status).toBe("success");
  });

  // 4. Results keyed by runtime name
  it("should key results by runtime name", async () => {
    const runtimes = [
      makeManifest({ name: "narrator" }),
      makeManifest({ name: "combat" }),
    ];
    const executeFn = vi
      .fn()
      .mockImplementation((rt: RuntimeManifest) =>
        Promise.resolve(makeResult({ runtimeId: rt.name })),
      );

    const map = await executeParallel(runtimes, executeFn);

    expect([...map.keys()]).toEqual(["narrator", "combat"]);
  });

  // 5. Execute function called for each runtime
  it("should call executeFn once for each runtime", async () => {
    const runtimes = [
      makeManifest({ name: "x" }),
      makeManifest({ name: "y" }),
      makeManifest({ name: "z" }),
    ];
    const executeFn = vi
      .fn()
      .mockImplementation((rt: RuntimeManifest) =>
        Promise.resolve(makeResult({ runtimeId: rt.name })),
      );

    await executeParallel(runtimes, executeFn);

    expect(executeFn).toHaveBeenCalledTimes(3);
    expect(executeFn).toHaveBeenCalledWith(runtimes[0]);
    expect(executeFn).toHaveBeenCalledWith(runtimes[1]);
    expect(executeFn).toHaveBeenCalledWith(runtimes[2]);
  });
});
