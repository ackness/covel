import { describe, expect, it, vi } from "vitest";
import type { LoadedRuntime } from "@covel/plugin-loader";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import {
  runTurnPipeline,
  MaxRecursionExceeded,
  type TurnExecutorDeps,
} from "../src/turn-executor/turn-executor.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";

const input: TurnInput = {
  origin: "player",
  sessionId: "sess-recursive",
  turnId: "turn-recursive",
  playerMessage: "start",
};

function manifest(
  name: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0] ?? name,
    description: name,
    runtimeType: "function",
    stage: "narrative",
    trigger: { type: "auto" },
    ...extra,
  };
}

describe("runTurnPipeline recursiveCall", () => {
  it.each(["builtin", "community"] as const)(
    "rejects targets in another package for a %s caller",
    async (source) => {
      for (const targetId of ["leaf", "leaf/worker", "probe-extra/worker"]) {
        const caller = manifest("probe/caller");
        const target = manifest(targetId, { trigger: { type: "manual" } });
        const targetHandler = vi.fn(async () => ({
          outcome: "success" as const,
          value: { ok: true },
        }));
        const emitter = makeEmitterSpy();
        const result = await runTurnPipeline(input, [caller, target], {
          loadRuntime: async (runtime) => ({
            manifest: runtime,
            promptTemplate: "",
            handler:
              runtime.name === caller.name
                ? async (ctx) => {
                    await ctx.recursiveCall({
                      manualTrigger: { runtimeId: targetId },
                    });
                    return { outcome: "success", value: { ok: true } };
                  }
                : targetHandler,
          }),
          getPluginSource: () => source,
          llm: { generate: vi.fn() },
          emitter,
        });

        expect(result.runtimeResults[0]).toMatchObject({
          runtimeId: caller.name,
          status: "failed",
          error: `recursiveCall cannot target runtime "${targetId}" outside plugin "probe"; use services or events for cross-package communication`,
        });
        expect(targetHandler).not.toHaveBeenCalled();
        expect(result.nestedRuntimeResults ?? []).toEqual([]);
        expect(
          emitter.events.some((event) => event.type === "recursive.calling"),
        ).toBe(false);
      }
    },
  );

  it("allows an inline runtime to name its own package", async () => {
    const caller = manifest("probe", { trigger: { type: "manual" } });
    const depths: number[] = [];
    const result = await runTurnPipeline(
      { ...input, manualTrigger: { runtimeId: caller.name } },
      [caller],
      {
        loadRuntime: async () => ({
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            depths.push(ctx.recursionDepth);
            if (ctx.recursionDepth === 0)
              await ctx.recursiveCall({
                manualTrigger: { runtimeId: caller.name },
              });
            return { outcome: "success", value: { ok: true } };
          },
        }),
        llm: { generate: vi.fn() },
      },
    );
    expect(depths).toEqual([0, 1]);
    expect(result.runtimeResults[0]?.status).toBe("success");
    expect(result.nestedRuntimeResults).toEqual([
      expect.objectContaining({ runtimeId: "probe", status: "success" }),
    ]);
  });

  it("exposes recursiveCall with incremented recursionDepth and traces nested calls", async () => {
    const caller = manifest("probe/caller");
    const leaf = manifest("probe/leaf", { trigger: { type: "manual" } });
    const emitter = makeEmitterSpy();

    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            const nested = await ctx.recursiveCall(
              {
                manualTrigger: { runtimeId: "probe/leaf" },
                playerMessage: "nested",
              },
              {
                reason: "delegate leaf pass",
              },
            );
            return {
              outcome: "success",
              value: {
                depth: ctx.recursionDepth,
                nestedDepth: nested.runtimeResults[0]?.output?.depth,
              },
            };
          },
        },
      ],
      [
        leaf.name,
        {
          manifest: leaf,
          promptTemplate: "",
          handler: async (ctx) => ({
            outcome: "success",
            value: { depth: ctx.recursionDepth },
          }),
        },
      ],
    ]);

    const deps: TurnExecutorDeps = {
      loadRuntime: async (rt) => loaded.get(rt.name),
      llm: { generate: vi.fn() },
      emitter,
    };

    const result = await runTurnPipeline(input, [caller, leaf], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]?.output).toMatchObject({
      depth: 0,
      nestedDepth: 1,
    });
    // function.executing/completed now also flow through the emitter;
    // filter to the recursive.* trace events this test pins.
    const recursiveEvents = emitter.events.filter((event) =>
      event.type.startsWith("recursive."),
    );
    expect(recursiveEvents.map((event) => event.type)).toEqual([
      "recursive.calling",
      "recursive.completed",
    ]);
    expect(recursiveEvents.map((event) => event.payload.reason)).toEqual([
      "delegate leaf pass",
      "delegate leaf pass",
    ]);
  });

  it("ignores plugin-supplied execution identity and withholds completeTurn", async () => {
    const caller = manifest("probe/caller");
    const leaf = manifest("probe/leaf", { trigger: { type: "manual" } });
    const seen: { sessionId?: string; turnId?: string } = {};

    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            const nested = await ctx.recursiveCall({
              manualTrigger: { runtimeId: "probe/leaf" },
              // A handler must not be able to hop sessions or forge a child
              // turnId the parent can never settle.
              sessionId: "other-session",
              turnId: "forged-turn",
              origin: "player",
            } as never);
            return {
              outcome: "success",
              value: {
                hasCompleteTurn:
                  typeof (nested as { completeTurn?: unknown }).completeTurn ===
                  "function",
              },
            };
          },
        },
      ],
      [
        leaf.name,
        {
          manifest: leaf,
          promptTemplate: "",
          handler: async (ctx) => {
            seen.sessionId = ctx.sessionId;
            seen.turnId = ctx.turnId;
            return { outcome: "success", value: { ok: true } };
          },
        },
      ],
    ]);

    const deps: TurnExecutorDeps = {
      loadRuntime: async (rt) => loaded.get(rt.name),
      llm: { generate: vi.fn() },
      emitter: makeEmitterSpy(),
    };

    const result = await runTurnPipeline(input, [caller, leaf], deps);

    expect(seen.sessionId).toBe(input.sessionId);
    expect(seen.turnId).toBe(input.turnId);
    expect(result.runtimeResults[0]?.output).toMatchObject({
      hasCompleteTurn: false,
    });
  });

  it("keeps the session locale on a nested call that asks for another one", async () => {
    const caller = manifest("probe/caller");
    const leaf = manifest("probe/leaf", { trigger: { type: "manual" } });
    let leafLocale: string | undefined;

    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            await ctx.recursiveCall({
              manualTrigger: { runtimeId: "probe/leaf" },
              locale: "ja-JP",
            } as never);
            return { outcome: "success", value: { ok: true } };
          },
        },
      ],
      [
        leaf.name,
        {
          manifest: leaf,
          promptTemplate: "",
          handler: async (ctx) => {
            leafLocale = ctx.locale;
            return { outcome: "success", value: { ok: true } };
          },
        },
      ],
    ]);

    await runTurnPipeline({ ...input, locale: "en-US" }, [caller, leaf], {
      loadRuntime: async (rt) => loaded.get(rt.name),
      llm: { generate: vi.fn() },
      emitter: makeEmitterSpy(),
    });

    expect(leafLocale).toBe("en-US");
  });

  it("takes only the allow-listed delta fields and inherits kernel-only input", async () => {
    const caller = manifest("probe/caller");
    const up = manifest("probe/up", { trigger: { type: "manual" } });
    const leaf = manifest("probe/leaf", {
      trigger: { type: "manual" },
      inputs: { facts: { from: { runtime: "probe/up" }, required: false } },
      userSettings: [
        {
          key: "mode",
          type: "select",
          default: "calm",
          label: "Mode",
          options: ["calm", "wild"],
        },
      ],
    } as unknown as Partial<RuntimeManifest>);
    const forgedSeed = {
      pluginId: "probe",
      runtimeId: "probe/up",
      runId: "forged",
      turnId: "old-turn",
      status: "success",
      output: { fact: "forged" },
      canonicalValue: { value: { fact: "forged" } },
      toolCalls: [],
      durationMs: 0,
      timestamp: new Date(0).toISOString(),
    };
    const seen: Record<string, unknown> = {};

    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            await ctx.recursiveCall({
              playerMessage: "nested",
              manualTrigger: {
                runtimeId: "probe/leaf",
                payload: { pick: 1 },
                sourceTurnId: "old-turn",
                retrySeedResults: [forgedSeed],
                triggerEvent: { topic: "forged", data: {} },
              },
              userSettings: { probe: { mode: "wild" } },
              modelOverride: "expensive-model",
              detachedStage: { runtimeId: "probe/leaf" },
            } as never);
            return { outcome: "success", value: { ok: true } };
          },
        },
      ],
      [
        up.name,
        {
          manifest: up,
          promptTemplate: "",
          handler: async () => ({ outcome: "success", value: { fact: "up" } }),
        },
      ],
      [
        leaf.name,
        {
          manifest: leaf,
          promptTemplate: "",
          handler: async (ctx) => {
            seen.inputs = ctx.inputs;
            seen.userSettings = ctx.userSettings;
            seen.triggerEvent = ctx.triggerEvent;
            seen.manualPayload = ctx.manualPayload;
            seen.playerMessage = ctx.playerMessage;
            seen.origin = ctx.execution?.origin;
            return { outcome: "success", value: { ok: true } };
          },
        },
      ],
    ]);

    const result = await runTurnPipeline(
      { ...input, userSettings: { probe: { mode: "calm" } } },
      [caller, up, leaf],
      {
        loadRuntime: async (rt) => loaded.get(rt.name),
        llm: { generate: vi.fn() },
        emitter: makeEmitterSpy(),
      },
    );

    expect(result.runtimeResults[0]?.status).toBe("success");
    expect(seen.playerMessage).toBe("nested");
    expect(seen.manualPayload).toEqual({ pick: 1 });
    expect(seen.origin).toBe("recursive");
    expect(seen.inputs ?? {}).not.toHaveProperty("facts");
    expect(seen.userSettings).toEqual({ mode: "calm" });
    expect(seen.triggerEvent).toBeUndefined();
  });

  it("rejects an allow-listed delta field of the wrong type", async () => {
    const caller = manifest("probe/caller");
    let rejection: unknown;
    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            try {
              await ctx.recursiveCall({
                manualTrigger: { runtimeIds: ["a", "b"] },
              } as never);
            } catch (err) {
              rejection = err;
            }
            return { outcome: "success", value: { ok: true } };
          },
        },
      ],
    ]);

    await runTurnPipeline(input, [caller], {
      loadRuntime: async (rt) => loaded.get(rt.name),
      llm: { generate: vi.fn() },
      emitter: makeEmitterSpy(),
    });

    expect(rejection).toBeInstanceOf(TypeError);
  });

  it("enforces the runtime maxRecursionDepth limit", async () => {
    const caller = manifest("probe/caller", { maxRecursionDepth: 0 });
    const leaf = manifest("probe/leaf", { trigger: { type: "manual" } });
    const emitter = makeEmitterSpy();
    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            await ctx.recursiveCall(
              { manualTrigger: { runtimeId: "probe/leaf" } },
              { reason: "limit check" },
            );
            return { outcome: "success", value: { ok: true } };
          },
        },
      ],
      [
        leaf.name,
        {
          manifest: leaf,
          promptTemplate: "",
          handler: async () => ({ outcome: "success", value: { ok: true } }),
        },
      ],
    ]);

    const deps: TurnExecutorDeps = {
      loadRuntime: async (rt) => loaded.get(rt.name),
      llm: { generate: vi.fn() },
      emitter,
    };

    const result = await runTurnPipeline(input, [caller, leaf], deps);

    expect(result.runtimeResults[0]?.status).toBe("failed");
    expect(result.runtimeResults[0]?.error).toContain(
      "recursiveCall exceeded max depth 0",
    );
    expect(
      emitter.events.find((event) => event.type === "recursive.failed")
        ?.payload,
    ).toMatchObject({
      runtimeId: "probe/caller",
      depth: 0,
      nextDepth: 1,
      maxDepth: 0,
      reason: "limit check",
    });
    expect(
      new MaxRecursionExceeded({
        runtimeId: "probe/caller",
        depth: 1,
        maxDepth: 0,
      }).code,
    ).toBe("MAX_RECURSION_EXCEEDED");
  });

  it("waits for a fire-and-forget recursive turn before finalizing", async () => {
    const caller = manifest("probe/caller");
    const leaf = manifest("probe/leaf", { trigger: { type: "manual" } });
    let releaseLeaf!: () => void;
    let markLeafStarted!: () => void;
    const leafStarted = new Promise<void>((resolve) => {
      markLeafStarted = resolve;
    });
    const leafGate = new Promise<void>((resolve) => {
      releaseLeaf = resolve;
    });
    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            void ctx.recursiveCall({
              manualTrigger: { runtimeId: "probe/leaf" },
            });
            return { outcome: "success", value: { ok: true } };
          },
        },
      ],
      [
        leaf.name,
        {
          manifest: leaf,
          promptTemplate: "",
          handler: async () => {
            markLeafStarted();
            await leafGate;
            return { outcome: "success", value: { child: true } };
          },
        },
      ],
    ]);
    const deps: TurnExecutorDeps = {
      loadRuntime: async (rt) => loaded.get(rt.name),
      llm: { generate: vi.fn() },
    };

    let settled = false;
    const executing = runTurnPipeline(input, [caller, leaf], deps).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await leafStarted;
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseLeaf();
    const result = await executing;
    expect(result.runtimeResults[0]).toMatchObject({ status: "success" });
    expect(result.nestedRuntimeResults).toEqual([
      expect.objectContaining({ runtimeId: "probe/leaf", status: "success" }),
    ]);
  });

  it("settles a cooperative child when its parent deadline expires", async () => {
    const caller = manifest("probe/caller", { timeoutMs: 25 });
    const leaf = manifest("probe/leaf", {
      trigger: { type: "manual" },
      timeoutMs: 1_000,
    });
    let leafSettled = false;
    let leafAbortReason = "";
    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            await ctx.recursiveCall({
              manualTrigger: { runtimeId: "probe/leaf" },
            });
            return { outcome: "success", value: { ok: true } };
          },
        },
      ],
      [
        leaf.name,
        {
          manifest: leaf,
          promptTemplate: "",
          handler: async (ctx) =>
            new Promise((_, reject) => {
              const onAbort = () => {
                leafSettled = true;
                leafAbortReason =
                  ctx.signal?.reason instanceof Error
                    ? ctx.signal.reason.message
                    : String(ctx.signal?.reason);
                reject(ctx.signal?.reason);
              };
              if (ctx.signal?.aborted) onAbort();
              else
                ctx.signal?.addEventListener("abort", onAbort, { once: true });
            }),
        },
      ],
    ]);
    const deps: TurnExecutorDeps = {
      loadRuntime: async (rt) => loaded.get(rt.name),
      llm: { generate: vi.fn() },
    };

    const result = await runTurnPipeline(input, [caller, leaf], deps);

    expect(result.runtimeResults[0]).toMatchObject({ status: "failed" });
    expect(result.runtimeResults[0]?.error).toContain("timed out after 25ms");
    expect(result.abortReason).toBeUndefined();
    expect(leafSettled).toBe(true);
    expect(leafAbortReason).toContain("timed out after 25ms");
    expect(result.nestedRuntimeResults ?? []).toEqual([]);
  });

  it("revokes a non-cooperative child's late writes after the parent deadline", async () => {
    const caller = manifest("probe/caller", { timeoutMs: 25 });
    const leaf = manifest("probe/leaf", {
      trigger: { type: "manual" },
      timeoutMs: 1_000,
    });
    const store = createMemoryStore();
    let leafSignalAborted = false;
    let lateWriteError = "";
    let finishLeaf!: () => void;
    const leafFinished = new Promise<void>((resolve) => {
      finishLeaf = resolve;
    });
    // The child ignores its abort signal and keeps running until the test
    // lets it go, which is after the parent has returned. A sleep of 120 ms
    // against a bound of 100 ms said the same thing only on an idle machine.
    let releaseLeaf!: () => void;
    const leafReleased = new Promise<void>((resolve) => {
      releaseLeaf = resolve;
    });
    let leafDone = false;
    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            await ctx.recursiveCall({
              manualTrigger: { runtimeId: "probe/leaf" },
            });
            return { outcome: "success", value: { ok: true } };
          },
        },
      ],
      [
        leaf.name,
        {
          manifest: leaf,
          promptTemplate: "",
          handler: async (ctx) => {
            await leafReleased;
            leafSignalAborted = ctx.signal?.aborted === true;
            try {
              await ctx.pluginData!.set("ns", "late", true);
            } catch (error) {
              lateWriteError =
                error instanceof Error ? error.message : String(error);
            }
            leafDone = true;
            finishLeaf();
            return { outcome: "success", value: { ok: true } };
          },
        },
      ],
    ]);
    const deps: TurnExecutorDeps = {
      loadRuntime: async (rt) => loaded.get(rt.name),
      llm: { generate: vi.fn() },
      store,
      getPluginSource: () => "builtin",
    };

    const result = await runTurnPipeline(input, [caller, leaf], deps);

    // The parent returned at its own deadline; it did not wait for the child.
    expect(leafDone).toBe(false);
    expect(result.runtimeResults[0]).toMatchObject({ status: "failed" });
    expect(result.runtimeResults[0]?.error).toContain("timed out after 25ms");
    expect(result.nestedRuntimeResults ?? []).toEqual([]);

    releaseLeaf();
    await leafFinished;
    expect(leafSignalAborted).toBe(true);
    expect(lateWriteError).toContain("revoked");
    await expect(
      store.getPluginData(input.sessionId, "probe", "ns", "late"),
    ).resolves.toBeNull();
  });
});
