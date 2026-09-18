import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import type { SubscriptionEvent } from "@covel/shared";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import type { HookResult } from "../src/hooks/types.js";

const invalidResults: Array<[string, unknown]> = [
  ["missing return", undefined],
  ["null", null],
  ["string", "private player content"],
  ["number", 1],
  ["array", []],
  ["missing action", {}],
  ["unknown action", { action: "private player content" }],
  ["missing abort reason", { action: "abort" }],
  ["non-string abort reason", { action: "abort", reason: {} }],
  ["null replacement", { action: "continue", replace: null }],
  [
    "scalar replacement",
    { action: "continue", replace: "private player content" },
  ],
  ["array replacement", { action: "continue", replace: [] }],
  ["native replacement", { action: "continue", replace: new Map() }],
];

describe.each(["PreRuntime", "TurnStop"] as const)(
  "%s dynamic Hook results",
  (event) => {
    it.each(invalidResults)(
      "isolates %s through Hook failure semantics",
      async (_label, value) => {
        const pipeline = createHookPipeline();
        const bus = createEventBus();
        const events: SubscriptionEvent[] = [];
        bus.onEmit((item) => events.push(item));
        const handler = vi.fn(async () => value as HookResult<unknown>);
        const next = vi.fn(async () => ({ action: "continue" as const }));
        pipeline.register({ id: "invalid", pluginId: "probe", event, handler });
        pipeline.register({
          id: "next",
          event,
          enforce: "post",
          handler: next,
        });
        try {
          await expect(
            pipeline.run(
              event,
              {
                event,
                sessionId: "session",
                turnId: "turn",
                runtimeId: "probe/main",
              },
              {},
              { eventBus: bus },
            ),
          ).resolves.toMatchObject({
            action: event === "TurnStop" ? "continue" : "abort",
          });
          expect(handler).toHaveBeenCalledTimes(1);
          expect(next).toHaveBeenCalledTimes(event === "TurnStop" ? 1 : 0);
          expect(events).toHaveLength(1);
          expect(events[0]?.type).toBe("hook.error");
          expect(events[0]?.payload).toMatchObject({
            event,
            sessionId: "session",
            turnId: "turn",
            runtimeId: "probe/main",
            hookId: "invalid",
            hookPluginId: "probe",
            reason: expect.any(String),
          });
          expect(JSON.stringify(events)).not.toContain(
            "private player content",
          );
        } finally {
          await bus.close();
        }
      },
    );
  },
);

it("keeps a valid null-prototype replacement and its execution artifacts", async () => {
  const pipeline = createHookPipeline();
  const artifact = Symbol("execution-artifact");
  const replacement = Object.create(null) as Record<string | symbol, unknown>;
  replacement.value = "rewritten";
  Object.defineProperty(replacement, artifact, { value: { pending: true } });
  const handler = vi.fn(async (_ctx: unknown, payload: unknown) => {
    expect(payload).toMatchObject({ value: "rewritten" });
    return { action: "continue" as const };
  });
  pipeline.register({
    id: "replacement",
    event: "PreRuntime",
    handler: async () => ({
      action: "continue",
      replace: { result: replacement },
    }),
  });
  pipeline.register({
    id: "observer",
    event: "PreRuntime",
    handler: async (
      _ctx,
      payload: { result: Record<string | symbol, unknown> },
    ) => {
      expect(Object.getPrototypeOf(payload.result)).toBeNull();
      expect(payload.result[artifact]).toEqual({ pending: true });
      expect(payload.result[artifact]).not.toBe(replacement[artifact]);
      return handler(_ctx, payload.result);
    },
  });
  const result = await pipeline.run(
    "PreRuntime",
    {
      event: "PreRuntime",
      sessionId: "session",
      turnId: "turn",
    },
    { result: { value: "original" } },
  );
  expect(result.action).toBe("continue");
  expect(handler).toHaveBeenCalledTimes(1);
});
