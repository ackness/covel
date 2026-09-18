import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  runPostRuntimeHook,
  runPreScheduleHook,
  runPreToolUseHook,
} from "../src/hooks/wire-helpers.js";
import {
  HOOK_SEMANTICS,
  type HookContext,
  type HookSemantic,
} from "../src/hooks/types.js";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";

const originalSemantic = HOOK_SEMANTICS.TurnStart;
afterEach(() => {
  vi.useRealTimers();
  HOOK_SEMANTICS.TurnStart = originalSemantic;
});
const context = {
  event: "TurnStart" as const,
  sessionId: "session",
  turnId: "turn",
};

function runtimeResult(): RuntimeResult {
  return {
    pluginId: "probe",
    runtimeId: "probe/main",
    runId: "run",
    turnId: "turn",
    status: "success",
    output: { value: "original" },
    toolCalls: [],
    durationMs: 0,
    timestamp: new Date().toISOString(),
  };
}

describe("Hook data ownership", () => {
  it.each<HookSemantic>(["first", "sequential", "stream", "parallel"])(
    "does not publish in-place writes under %s semantics",
    async (semantic) => {
      HOOK_SEMANTICS.TurnStart = semantic;
      const pipeline = createHookPipeline();
      const input = { nested: { value: "original" }, values: ["original"] };
      pipeline.register<typeof input>({
        id: "mutate",
        event: "TurnStart",
        async handler(_ctx, payload) {
          payload.nested.value = "changed";
          payload.values.push("changed");
          return { action: "continue" };
        },
      });
      const observed: (typeof input)[] = [];
      pipeline.register<typeof input>({
        id: "observe",
        event: "TurnStart",
        async handler(_ctx, payload) {
          observed.push(payload);
          return { action: "continue" };
        },
      });
      expect(await pipeline.run("TurnStart", context, input)).toEqual({
        action: "continue",
      });
      expect(input).toEqual({
        nested: { value: "original" },
        values: ["original"],
      });
      expect(observed).toEqual([input]);
    },
  );

  it.each([false, true])(
    "keeps match-filter writes out of handlers (match=%s)",
    async (matches) => {
      const pipeline = createHookPipeline();
      const input = { nested: { value: "original" } };
      const handler = vi.fn(
        async (_ctx: HookContext, payload: typeof input) => {
          expect(payload).toEqual(input);
          expect(payload.nested.value).toBe("original");
          return { action: "continue" as const };
        },
      );
      pipeline.register<typeof input>({
        id: "match",
        event: "TurnStart",
        match(payload) {
          payload.nested.value = "filter mutation";
          return matches;
        },
        handler,
      });
      expect(await pipeline.run("TurnStart", context, input)).toEqual({
        action: "continue",
      });
      expect(input.nested.value).toBe("original");
      expect(handler).toHaveBeenCalledTimes(matches ? 1 : 0);
    },
  );

  it("keeps a pipeline snapshot while the caller and an earlier handler retain references", async () => {
    const pipeline = createHookPipeline();
    const input = { nested: { value: "original" } };
    const replacement = { nested: { value: "accepted" } };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    pipeline.register<typeof input>({
      id: "replace",
      event: "TurnStart",
      async handler() {
        return { action: "continue", replace: replacement };
      },
    });
    pipeline.register<typeof input>({
      id: "wait",
      event: "TurnStart",
      async handler(_ctx, payload) {
        entered.resolve();
        await release.promise;
        expect(payload.nested.value).toBe("accepted");
        payload.nested.value = "unreturned write";
        return { action: "continue" };
      },
    });
    const running = pipeline.run("TurnStart", context, input);
    await entered.promise;
    input.nested.value = "caller mutation";
    replacement.nested.value = "late handler mutation";
    release.resolve();
    expect(await running).toEqual({
      action: "continue",
      replace: { nested: { value: "accepted" } },
    });
  });

  it("takes ownership of a replacement before waiting for trace delivery", async () => {
    const pipeline = createHookPipeline();
    const replacement = { nested: { value: "accepted" } };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    pipeline.register({
      id: "replace",
      event: "TurnStart",
      async handler() {
        return { action: "continue", replace: replacement };
      },
    });
    const running = pipeline.run(
      "TurnStart",
      context,
      { nested: { value: "original" } },
      {
        emitter: {
          sessionId: "session",
          turnId: "turn",
          async emit(type, payload) {
            if (type === "hook.rewrote") {
              entered.resolve();
              await release.promise;
              const diff = payload.diff as {
                before: typeof replacement;
                after: typeof replacement;
              };
              diff.before.nested.value = "trace mutation";
              diff.after.nested.value = "trace mutation";
            }
          },
        },
      },
    );
    await entered.promise;
    replacement.nested.value = "late handler mutation";
    release.resolve();
    expect(await running).toEqual({
      action: "continue",
      replace: { nested: { value: "accepted" } },
    });
  });

  it("ignores payload writes after a PostRuntime timeout", async () => {
    vi.useFakeTimers();
    const pipeline = createHookPipeline();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    pipeline.register<{
      result: { pluginId: string; output: { value: string } };
    }>({
      id: "late",
      event: "PostRuntime",
      timeoutMs: 50,
      async handler(_ctx, payload) {
        entered.resolve();
        await release.promise;
        payload.result.pluginId = "forged";
        payload.result.output.value = "late";
        finished.resolve();
        return { action: "continue" };
      },
    });
    const input = runtimeResult();
    const running = runPostRuntimeHook(
      {
        pipeline,
        sessionId: "session",
        turnId: "turn",
        pluginId: "probe",
        runtimeId: "probe/main",
      },
      input,
    );
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(51);
      const result = await running;
      release.resolve();
      await finished.promise;
      expect(result).toMatchObject({
        pluginId: "probe",
        output: { value: "original" },
      });
      expect(input).toMatchObject({
        pluginId: "probe",
        output: { value: "original" },
      });
    } finally {
      release.resolve();
      await running;
    }
  });

  it.each([false, true])(
    "pins runtime identity for both in-place and returned rewrites (replace=%s)",
    async (replace) => {
      const pipeline = createHookPipeline();
      pipeline.register<{ result: Record<string, unknown> }>({
        id: "forge",
        event: "PostRuntime",
        async handler(_ctx, payload) {
          payload.result.pluginId = "forged";
          payload.result.runId = "forged";
          return replace
            ? { action: "continue", replace: payload }
            : { action: "continue" };
        },
      });
      const input = runtimeResult();
      const result = await runPostRuntimeHook(
        {
          pipeline,
          sessionId: "session",
          turnId: "turn",
          pluginId: "probe",
          runtimeId: "probe/main",
        },
        input,
      );
      expect(result).toMatchObject({
        pluginId: "probe",
        runtimeId: "probe/main",
        runId: "run",
        turnId: "turn",
      });
      expect(input.pluginId).toBe("probe");
    },
  );

  it("keeps manifest ownership and the provider tool-call id authoritative", async () => {
    const pipeline = createHookPipeline();
    pipeline.register<{ triggered: Array<{ name: string; pluginId: string }> }>(
      {
        id: "forge-schedule",
        event: "PreSchedule",
        async handler(_ctx, payload) {
          payload.triggered[0]!.pluginId = "forged";
          return { action: "continue", replace: payload };
        },
      },
    );
    pipeline.register<{
      toolCall: { id: string; name: string; arguments: string };
    }>({
      id: "forge-call",
      event: "PreToolUse",
      async handler(_ctx, payload) {
        payload.toolCall.id = "forged";
        payload.toolCall.arguments = '{"allowed":true}';
        return { action: "continue", replace: payload };
      },
    });
    const manifest = {
      name: "probe/main",
      pluginId: "probe",
      stage: "narrative",
      trigger: { type: "auto" },
    } as RuntimeManifest;
    const opts = {
      pipeline,
      sessionId: "session",
      turnId: "turn",
      pluginId: "probe",
      runtimeId: "probe/main",
    };
    const scheduled = await runPreScheduleHook(opts, { triggered: [manifest] });
    expect(scheduled).toEqual([manifest]);
    expect(manifest.pluginId).toBe("probe");
    const call = { id: "call", name: "probe", arguments: "{}" };
    expect(await runPreToolUseHook(opts, call)).toEqual({
      skipped: false,
      toolCall: { ...call, arguments: '{"allowed":true}' },
    });
    expect(call).toEqual({ id: "call", name: "probe", arguments: "{}" });
  });
});
