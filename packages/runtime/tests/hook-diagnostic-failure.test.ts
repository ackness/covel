import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import type { HookResult } from "../src/hooks/types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Hook diagnostic delivery failures", () => {
  it.each(["hook.fired", "hook.rewrote", "hook.aborted"] as const)(
    "keeps the policy result when %s trace delivery rejects",
    async (traceType) => {
      const pipeline = createHookPipeline();
      const result: HookResult<{ value: string }> =
        traceType === "hook.aborted"
          ? { action: "abort", reason: "policy denied" }
          : { action: "continue", replace: { value: "rewritten" } };
      const handler = vi.fn(async () => result);
      pipeline.register({
        id: "policy",
        pluginId: "probe",
        event: "PreRuntime",
        handler,
      });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const delivered: string[] = [];
      await expect(
        pipeline.run(
          "PreRuntime",
          {
            event: "PreRuntime",
            sessionId: "session",
            turnId: "turn",
            runtimeId: "probe/main",
          },
          { value: "original" },
          {
            emitter: {
              sessionId: "session",
              turnId: "turn",
              traceId: "trace",
              async emit(type) {
                delivered.push(type);
                if (type === traceType)
                  throw new Error("private transport credential");
              },
            },
          },
        ),
      ).resolves.toEqual(result);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(delivered).toContain(traceType);
      expect(warning).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          event: "PreRuntime",
          sessionId: "session",
          turnId: "turn",
          hookId: "policy",
          hookPluginId: "probe",
          runtimeId: "probe/main",
          traceId: "trace",
        }),
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain(
        "private transport credential",
      );
    },
  );

  it.each(["PreRuntime", "TurnStop"] as const)(
    "retains %s failure semantics when diagnostic event publication throws",
    async (event) => {
      for (const kind of [
        "abort",
        "handler error",
        "match error",
        "timeout",
        "invalid input",
      ] as const) {
        vi.useFakeTimers();
        const pipeline = createHookPipeline();
        const bus = createEventBus();
        const publish = vi.spyOn(bus, "emit").mockImplementation(() => {
          throw new Error("private bus credential");
        });
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        pipeline.register({
          id: "policy",
          pluginId: "probe",
          event,
          timeoutMs: 10,
          match() {
            if (kind === "match error") throw new Error("policy failed");
            return true;
          },
          async handler() {
            if (kind === "timeout")
              return new Promise<HookResult<unknown>>(() => {});
            if (kind === "handler error") throw new Error("policy failed");
            return { action: "abort", reason: "policy denied" };
          },
        });
        const running = pipeline
          .run(
            event,
            {
              event,
              sessionId: "session",
              turnId: "turn",
              runtimeId: "probe/main",
            },
            kind === "invalid input" ? { callback: () => {} } : {},
            { eventBus: bus },
          )
          .then(
            (result) => result,
            (error: unknown) => error,
          );
        await vi.advanceTimersByTimeAsync(11);
        expect(await running, kind).toMatchObject({
          action: event === "TurnStop" ? "continue" : "abort",
        });
        expect(publish).toHaveBeenCalled();
        expect(warning).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            event,
            sessionId: "session",
            turnId: "turn",
            hookId: "policy",
            hookPluginId: "probe",
          }),
        );
        expect(JSON.stringify(warning.mock.calls)).not.toContain(
          "private bus credential",
        );
        await bus.close();
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    },
  );
});
