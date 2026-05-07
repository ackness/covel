import { describe, it, expect, vi } from "vitest";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import { executeParallel, resolveFailure } from "../src/parallel-executor.js";

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

// ── resolveFailure ──────────────────────────────────────────────

describe("resolveFailure", () => {
  // 6. Dependent skipped
  it("should skip runtimes that depend on the failed runtime", () => {
    const failed = makeManifest({ name: "A", priority: 200 });
    const pending = [makeManifest({ name: "B", priority: 600 })];
    const deps = new Map([["B", ["A"]]]);

    const resolution = resolveFailure(failed, pending, deps);

    expect(resolution.skip).toHaveLength(1);
    expect(resolution.skip[0].manifest.name).toBe("B");
    expect(resolution.skip[0].reason).toContain("A");
    expect(resolution.continue).toHaveLength(0);
  });

  // 7. Independent continues
  it("should continue runtimes that do not depend on the failed runtime", () => {
    const failed = makeManifest({ name: "A", priority: 200 });
    const pending = [makeManifest({ name: "C", priority: 700 })];
    const deps = new Map<string, readonly string[]>();

    const resolution = resolveFailure(failed, pending, deps);

    expect(resolution.continue).toHaveLength(1);
    expect(resolution.continue[0].manifest.name).toBe("C");
    expect(resolution.continue[0].degraded).toBe(false);
    expect(resolution.skip).toHaveLength(0);
  });

  // 8. Narrator always continues (degraded: true)
  it("should continue narrator (priority 500) in degraded mode even if dependent", () => {
    const failed = makeManifest({ name: "A", priority: 200 });
    const narrator = makeManifest({ name: "narrator", priority: 500 });
    const pending = [narrator];
    const deps = new Map([["narrator", ["A"]]]);

    const resolution = resolveFailure(failed, pending, deps);

    expect(resolution.skip).toHaveLength(0);
    expect(resolution.continue).toHaveLength(1);
    expect(resolution.continue[0].manifest.name).toBe("narrator");
    expect(resolution.continue[0].degraded).toBe(true);
  });

  // 9. No pending runtimes
  it("should return empty skip and continue when no pending runtimes", () => {
    const failed = makeManifest({ name: "A", priority: 200 });
    const pending: readonly RuntimeManifest[] = [];
    const deps = new Map<string, readonly string[]>();

    const resolution = resolveFailure(failed, pending, deps);

    expect(resolution.skip).toHaveLength(0);
    expect(resolution.continue).toHaveLength(0);
  });

  // 10. Multiple dependents
  it("should skip all runtimes that depend on the failed runtime", () => {
    const failed = makeManifest({ name: "A", priority: 200 });
    const pending = [
      makeManifest({ name: "B", priority: 600 }),
      makeManifest({ name: "D", priority: 700 }),
    ];
    const deps = new Map([
      ["B", ["A"]],
      ["D", ["A"]],
    ]);

    const resolution = resolveFailure(failed, pending, deps);

    expect(resolution.skip).toHaveLength(2);
    const skippedNames = resolution.skip.map((s) => s.manifest.name);
    expect(skippedNames).toContain("B");
    expect(skippedNames).toContain("D");
    expect(resolution.continue).toHaveLength(0);
  });
});
