import { describe, expect, it, vi } from "vitest";
import type { LoadedRuntime } from "@covel/plugin-loader";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  executeTurn,
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

describe("executeTurn recursiveCall", () => {
  it("exposes recursiveCall with incremented recursionDepth and traces nested calls", async () => {
    const caller = manifest("caller");
    const leaf = manifest("leaf", { trigger: { type: "manual" } });
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
                manualTrigger: { runtimeId: "leaf" },
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

    const result = await executeTurn(input, [caller, leaf], deps);

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
    const caller = manifest("caller");
    const leaf = manifest("leaf", { trigger: { type: "manual" } });
    const seen: { sessionId?: string; turnId?: string } = {};

    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            const nested = await ctx.recursiveCall({
              manualTrigger: { runtimeId: "leaf" },
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

    const result = await executeTurn(input, [caller, leaf], deps);

    expect(seen.sessionId).toBe(input.sessionId);
    expect(seen.turnId).toBe(input.turnId);
    expect(result.runtimeResults[0]?.output).toMatchObject({
      hasCompleteTurn: false,
    });
  });

  it("keeps the session locale on a nested call that asks for another one", async () => {
    const caller = manifest("caller");
    const leaf = manifest("leaf", { trigger: { type: "manual" } });
    let leafLocale: string | undefined;

    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            await ctx.recursiveCall({
              manualTrigger: { runtimeId: "leaf" },
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

    await executeTurn(
      { origin: "player", ...input, locale: "en-US" },
      [caller, leaf],
      {
        loadRuntime: async (rt) => loaded.get(rt.name),
        llm: { generate: vi.fn() },
        emitter: makeEmitterSpy(),
      },
    );

    expect(leafLocale).toBe("en-US");
  });

  it("enforces the runtime maxRecursionDepth limit", async () => {
    const caller = manifest("caller", { maxRecursionDepth: 0 });
    const leaf = manifest("leaf", { trigger: { type: "manual" } });
    const emitter = makeEmitterSpy();
    const loaded = new Map<string, LoadedRuntime>([
      [
        caller.name,
        {
          manifest: caller,
          promptTemplate: "",
          handler: async (ctx) => {
            await ctx.recursiveCall(
              { manualTrigger: { runtimeId: "leaf" } },
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

    const result = await executeTurn(input, [caller, leaf], deps);

    expect(result.runtimeResults[0]?.status).toBe("failed");
    expect(result.runtimeResults[0]?.error).toContain(
      "recursiveCall exceeded max depth 0",
    );
    expect(
      emitter.events.find((event) => event.type === "recursive.failed")
        ?.payload,
    ).toMatchObject({
      runtimeId: "caller",
      depth: 0,
      nextDepth: 1,
      maxDepth: 0,
      reason: "limit check",
    });
    expect(
      new MaxRecursionExceeded({ runtimeId: "caller", depth: 1, maxDepth: 0 })
        .code,
    ).toBe("MAX_RECURSION_EXCEEDED");
  });

  it("waits for a fire-and-forget recursive turn before finalizing", async () => {
    const caller = manifest("caller");
    const leaf = manifest("leaf", { trigger: { type: "manual" } });
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
            void ctx.recursiveCall({ manualTrigger: { runtimeId: "leaf" } });
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
    const executing = executeTurn(input, [caller, leaf], deps).then(
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
      expect.objectContaining({ runtimeId: "leaf", status: "success" }),
    ]);
  });

  it("settles a cooperative child when its parent deadline expires", async () => {
    const caller = manifest("caller", { timeoutMs: 25 });
    const leaf = manifest("leaf", {
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
            await ctx.recursiveCall({ manualTrigger: { runtimeId: "leaf" } });
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

    const result = await executeTurn(input, [caller, leaf], deps);

    expect(result.runtimeResults[0]).toMatchObject({ status: "failed" });
    expect(result.runtimeResults[0]?.error).toContain("timed out after 25ms");
    expect(result.abortReason).toBeUndefined();
    expect(leafSettled).toBe(true);
    expect(leafAbortReason).toContain("timed out after 25ms");
    expect(result.nestedRuntimeResults ?? []).toEqual([]);
  });

  it("revokes a non-cooperative child's late writes after the parent deadline", async () => {
    const caller = manifest("caller", { timeoutMs: 25 });
    const leaf = manifest("leaf", {
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
            await ctx.recursiveCall({ manualTrigger: { runtimeId: "leaf" } });
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
              await (
                ctx.store as unknown as Pick<DataStore, "setPluginData">
              ).setPluginData({
                id: "late",
                sessionId: ctx.sessionId,
                pluginId: ctx.pluginId,
                namespace: "ns",
                key: "late",
                value: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
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

    const result = await executeTurn(input, [caller, leaf], deps);

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
      store.getPluginData(input.sessionId, "leaf", "ns", "late"),
    ).resolves.toBeNull();
  });
});
