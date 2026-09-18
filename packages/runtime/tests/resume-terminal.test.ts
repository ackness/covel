import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import type {
  RuntimeManifest,
  RuntimeResult,
  SubscriptionEvent,
} from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { resumeSuspendedRuntime } from "../src/resume/turn-resume.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";

afterEach(() => vi.useRealTimers());

function fixture(runtimeType: "agent" | "function" = "agent", recover = false) {
  const manifest: RuntimeManifest = {
    name: "probe/main",
    pluginId: "probe",
    stage: "narrative",
    outputKind: "plugin",
    runtimeType,
    trigger: { type: "auto" },
    timeoutMs: 1000,
    maxRetries: 0,
  };
  const suspension: SuspensionRecord = {
    id: "suspension",
    sessionId: "session",
    turnId: "turn",
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    reason: "input",
    resumeSchema: {},
    createdAt: new Date().toISOString(),
    pendingContinuation: {
      executionContext: {
        executionId: "previous-run",
        origin: "manual",
        countPolicy: "none",
      },
      messages: [],
      toolCallsSoFar: [],
      pendingProposals: [],
    },
  };
  const eventBus = createEventBus();
  const events: SubscriptionEvent[] = [];
  eventBus.onEmit((event) => events.push(event));
  const observed: RuntimeResult[] = [];
  const hookPipeline = createHookPipeline();
  hookPipeline.register({
    id: "observe-terminal",
    event: "PostRuntime",
    async handler(_context, payload) {
      const { result } = payload as { result: RuntimeResult };
      observed.push(result);
      return recover
        ? {
            action: "continue",
            replace: {
              result: {
                ...result,
                status: "success",
                output: { recovered: true },
              },
            },
          }
        : { action: "continue" };
    },
  });
  const handler = vi.fn(async () => ({
    outcome: "success",
    value: { text: "done" },
  }));
  const generate = vi.fn(async () => ({
    content: "done",
    toolCalls: [],
    finishReason: "stop" as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const onRuntimeComplete = vi.fn(async () => {});
  const deps: TurnExecutorDeps = {
    eventBus,
    hookPipeline,
    onRuntimeComplete,
    llm: { generate },
    loadRuntime: async () => ({ manifest, promptTemplate: "probe", handler }),
  };
  const failedEvents = () =>
    events.filter((event) => event.type === "runtime.failed");
  return {
    manifest,
    suspension,
    deps,
    handler,
    generate,
    observed,
    eventBus,
    failedEvents,
    onRuntimeComplete,
  };
}

describe("resumed runtime terminal failures", () => {
  it.each([
    { kind: "agent", recover: false },
    { kind: "agent", recover: true },
    { kind: "function", recover: false },
    { kind: "function", recover: true },
  ] as const)(
    "finalizes thrown $kind failures exactly once (recover=$recover)",
    async ({ kind, recover }) => {
      const f = fixture(kind, recover);
      f.handler.mockRejectedValue(new Error("synthetic execution failure"));
      f.generate.mockRejectedValue(new Error("synthetic execution failure"));
      try {
        const result = await resumeSuspendedRuntime(
          f.suspension,
          {},
          f.manifest,
          f.deps,
        );
        expect(result).toMatchObject({
          pluginId: "probe",
          runtimeId: "probe/main",
          turnId: "turn",
          status: recover ? "success" : "failed",
          output: recover ? { recovered: true } : null,
        });
        expect(result.runId).not.toBe("previous-run");
        expect(f.observed).toHaveLength(1);
        expect(f.observed[0]).toMatchObject({
          status: "failed",
          error: expect.stringContaining("synthetic execution failure"),
          runId: result.runId,
        });
        expect(f.onRuntimeComplete).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            status: recover ? "success" : "failed",
            ...(!recover
              ? {
                  error: expect.stringContaining("synthetic execution failure"),
                }
              : {}),
          }),
        );
        expect(f.failedEvents()).toHaveLength(recover ? 0 : 1);
      } finally {
        await f.eventBus.close();
      }
    },
  );

  it.each(["missing runtime", "missing completion"])(
    "reports returned failures: %s",
    async (kind) => {
      const f = fixture();
      try {
        const result = await resumeSuspendedRuntime(
          f.suspension,
          {},
          {
            ...f.manifest,
            requireExplicitCompletion: kind === "missing completion",
          },
          {
            ...f.deps,
            ...(kind === "missing runtime"
              ? { loadRuntime: async () => undefined }
              : {}),
          },
        );
        expect(result.status).toBe("failed");
        expect(f.observed).toHaveLength(1);
        expect(f.onRuntimeComplete).toHaveBeenCalledTimes(1);
        expect(f.failedEvents()).toHaveLength(1);
      } finally {
        await f.eventBus.close();
      }
    },
  );

  it.each(["agent", "function"] as const)(
    "does not double-finalize successful %s continuations",
    async (kind) => {
      const f = fixture(kind);
      try {
        const result = await resumeSuspendedRuntime(
          f.suspension,
          {},
          f.manifest,
          f.deps,
        );
        expect(result.status).toBe("success");
        expect(f.observed).toHaveLength(1);
        expect(f.failedEvents()).toHaveLength(0);
      } finally {
        await f.eventBus.close();
      }
    },
  );

  it("keeps the original failure if the completion callback rejects", async () => {
    const f = fixture();
    f.generate.mockRejectedValue(new Error("original failure"));
    f.onRuntimeComplete.mockRejectedValue(new Error("observer failure"));
    try {
      const result = await resumeSuspendedRuntime(
        f.suspension,
        {},
        f.manifest,
        f.deps,
      );
      expect(result).toMatchObject({
        status: "failed",
        error: expect.stringContaining("original failure"),
      });
      expect(f.observed).toHaveLength(1);
      expect(f.failedEvents()).toHaveLength(1);
    } finally {
      await f.eventBus.close();
    }
  });

  it("cancels PreRuntime before loading the continuation", async () => {
    const f = fixture();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hookSignal: AbortSignal | undefined;
    f.deps.hookPipeline!.register({
      id: "wait-before-resume",
      event: "PreRuntime",
      async handler(context) {
        hookSignal = context.signal;
        entered.resolve();
        await release.promise;
        return { action: "continue" };
      },
    });
    const loadRuntime = vi.fn(f.deps.loadRuntime!);
    const running = resumeSuspendedRuntime(f.suspension, {}, f.manifest, {
      ...f.deps,
      loadRuntime,
      turnControl: { executionSignal: controller.signal },
    });
    try {
      await entered.promise;
      controller.abort(new Error("host is closing"));
      expect(hookSignal?.aborted).toBe(true);
      const result = await running;
      expect(result).toMatchObject({
        status: "failed",
        output: null,
        error: "host is closing",
      });
      expect(loadRuntime).not.toHaveBeenCalled();
      expect(f.failedEvents()).toHaveLength(1);
    } finally {
      release.resolve();
      await running.catch(() => {});
      await f.eventBus.close();
    }
  });

  it("cannot recover a resumed function timeout through PostRuntime", async () => {
    vi.useFakeTimers();
    const f = fixture("function", true);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.handler.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { outcome: "success", value: { text: "late" } };
    });
    const running = resumeSuspendedRuntime(
      f.suspension,
      {},
      f.manifest,
      f.deps,
    );
    const settled = running.then(
      (result) => result,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1001);
      const result = await settled;
      expect(result).toMatchObject({
        status: "failed",
        output: null,
        error: expect.stringContaining("timed out"),
      });
      expect(f.observed).toHaveLength(1);
      expect(f.failedEvents()).toHaveLength(1);
    } finally {
      release.resolve();
      await settled;
      await f.eventBus.close();
    }
  });
});
