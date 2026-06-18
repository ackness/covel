/**
 * Hook lifecycle pipeline tests (S4-T3).
 *
 * Covers:
 * - Each HookEvent type fires in order
 * - continue / replace / abort semantics
 * - Timeout triggers abort + hook.timeout event
 * - Thrown exception becomes abort + hook.error event
 * - Post* hooks cannot abort (abort logged but operation result unchanged)
 * - match filter skips non-matching handlers
 * - clear() isolates tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEventBus } from "@covel/events";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { HOOK_SEMANTICS } from "../src/hooks/types.js";
import type {
  HookContext,
  HookResult,
  HookEvent,
  HookSemantic,
} from "../src/hooks/types.js";
import type { HookPipeline } from "../src/hooks/pipeline.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeCtx(event: HookEvent = "TurnStart"): HookContext {
  return { event, sessionId: "sess-hook", turnId: "turn-hook" };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("HookPipeline", () => {
  let pipeline: HookPipeline;

  beforeEach(() => {
    pipeline = createHookPipeline();
  });

  afterEach(() => {
    HOOK_SEMANTICS.TurnStart = "parallel";
  });

  describe("ordering", () => {
    it("runs enforce groups before global/plugin grouping and preserves insertion order within each group", async () => {
      const order: string[] = [];

      pipeline.register({
        id: "global:PreRuntime:normal-a",
        event: "PreRuntime",
        handler: vi.fn().mockImplementation(async () => {
          order.push("global-normal-a");
          return { action: "continue" };
        }),
      });
      pipeline.register({
        id: "plugin-x:PreRuntime:pre",
        event: "PreRuntime",
        pluginId: "plugin-x",
        enforce: "pre",
        handler: vi.fn().mockImplementation(async () => {
          order.push("plugin-pre");
          return { action: "continue" };
        }),
      });
      pipeline.register({
        id: "global:PreRuntime:pre",
        event: "PreRuntime",
        enforce: "pre",
        handler: vi.fn().mockImplementation(async () => {
          order.push("global-pre");
          return { action: "continue" };
        }),
      });
      pipeline.register({
        id: "plugin-x:PreRuntime:normal",
        event: "PreRuntime",
        pluginId: "plugin-x",
        handler: vi.fn().mockImplementation(async () => {
          order.push("plugin-normal");
          return { action: "continue" };
        }),
      });
      pipeline.register({
        id: "global:PreRuntime:post",
        event: "PreRuntime",
        enforce: "post",
        handler: vi.fn().mockImplementation(async () => {
          order.push("global-post");
          return { action: "continue" };
        }),
      });

      await pipeline.run("PreRuntime", makeCtx("PreRuntime"), {});

      expect(order).toEqual([
        "global-pre",
        "plugin-pre",
        "global-normal-a",
        "plugin-normal",
        "global-post",
      ]);
    });
  });

  describe("basic registration and execution", () => {
    it("returns continue when no handlers are registered", async () => {
      const result = await pipeline.run("TurnStart", makeCtx(), { foo: "bar" });
      expect(result.action).toBe("continue");
    });

    it("calls a registered handler with correct ctx and payload", async () => {
      const handler = vi.fn().mockResolvedValue({ action: "continue" });
      pipeline.register({
        id: "test:TurnStart:0",
        event: "TurnStart",
        handler,
      });

      const ctx = makeCtx("TurnStart");
      const payload = { playerMessage: "hello", activeRuntimes: [] };
      await pipeline.run("TurnStart", ctx, payload);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(ctx, payload);
    });

    it("runs multiple handlers in registration order", async () => {
      const order: string[] = [];
      const h1 = vi.fn().mockImplementation(async () => {
        order.push("h1");
        return { action: "continue" };
      });
      const h2 = vi.fn().mockImplementation(async () => {
        order.push("h2");
        return { action: "continue" };
      });

      pipeline.register({
        id: "test:PreRuntime:0",
        event: "PreRuntime",
        handler: h1,
      });
      pipeline.register({
        id: "test:PreRuntime:1",
        event: "PreRuntime",
        handler: h2,
      });

      await pipeline.run("PreRuntime", makeCtx("PreRuntime"), {});

      expect(order).toEqual(["h1", "h2"]);
    });

    it("does not run handlers for a different event", async () => {
      const handler = vi.fn().mockResolvedValue({ action: "continue" });
      pipeline.register({ id: "test:TurnStop:0", event: "TurnStop", handler });

      await pipeline.run("TurnStart", makeCtx("TurnStart"), {});
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("replace semantics (shallow merge)", () => {
    it("merges replace patch into payload for downstream handlers", async () => {
      const h1 = vi
        .fn()
        .mockResolvedValue({ action: "continue", replace: { x: 99 } });
      const h2 = vi.fn().mockResolvedValue({ action: "continue" });

      pipeline.register({
        id: "test:PreToolUse:0",
        event: "PreToolUse",
        handler: h1,
      });
      pipeline.register({
        id: "test:PreToolUse:1",
        event: "PreToolUse",
        handler: h2,
      });

      await pipeline.run("PreToolUse", makeCtx("PreToolUse"), { x: 1, y: 2 });

      // h2 should see the patched payload
      expect(h2).toHaveBeenCalledWith(expect.anything(), { x: 99, y: 2 });
    });

    it("returns accumulated replace in the final result", async () => {
      const h1 = vi
        .fn()
        .mockResolvedValue({ action: "continue", replace: { a: 1 } });
      const h2 = vi
        .fn()
        .mockResolvedValue({ action: "continue", replace: { b: 2 } });

      pipeline.register({
        id: "test:PreRuntime:0",
        event: "PreRuntime",
        handler: h1,
      });
      pipeline.register({
        id: "test:PreRuntime:1",
        event: "PreRuntime",
        handler: h2,
      });

      const result = await pipeline.run("PreRuntime", makeCtx("PreRuntime"), {
        a: 0,
        b: 0,
      });
      expect(result.action).toBe("continue");
      expect(
        (result as { action: "continue"; replace?: Record<string, unknown> })
          .replace,
      ).toMatchObject({ a: 1, b: 2 });
    });
  });

  describe("semantic table", () => {
    it("declares all event semantics", () => {
      const expected: Record<HookEvent, HookSemantic> = {
        TurnStart: "parallel",
        PreRuntime: "sequential",
        PostContextAssembly: "sequential",
        PreLLMCall: "sequential",
        PostLLMResponse: "sequential",
        PostRuntime: "parallel",
        PreToolUse: "sequential",
        PostToolUse: "sequential",
        PreStateCommit: "sequential",
        PostStateCommit: "parallel",
        TurnStop: "parallel",
      };

      expect(HOOK_SEMANTICS).toEqual(expected);
    });

    it("parallel hooks settle all handlers and keep the payload result unchanged", async () => {
      const h1 = vi
        .fn()
        .mockResolvedValue({ action: "continue", replace: { x: 2 } });
      const h2 = vi.fn().mockRejectedValue(new Error("audit failed"));
      const h3 = vi
        .fn()
        .mockResolvedValue({ action: "abort", reason: "parallel abort" });

      pipeline.register({
        id: "test:TurnStart:0",
        event: "TurnStart",
        handler: h1,
      });
      pipeline.register({
        id: "test:TurnStart:1",
        event: "TurnStart",
        handler: h2,
      });
      pipeline.register({
        id: "test:TurnStart:2",
        event: "TurnStart",
        handler: h3,
      });

      const result = await pipeline.run("TurnStart", makeCtx(), { x: 1 });

      expect(result).toEqual({ action: "continue" });
      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
      expect(h3).toHaveBeenCalledOnce();
    });

    it("first hooks stop after the first replacement result", async () => {
      HOOK_SEMANTICS.TurnStart = "first";
      const h1 = vi.fn().mockResolvedValue({ action: "continue" });
      const h2 = vi
        .fn()
        .mockResolvedValue({ action: "continue", replace: { choice: "a" } });
      const h3 = vi
        .fn()
        .mockResolvedValue({ action: "continue", replace: { choice: "b" } });

      pipeline.register({
        id: "test:TurnStart:0",
        event: "TurnStart",
        handler: h1,
      });
      pipeline.register({
        id: "test:TurnStart:1",
        event: "TurnStart",
        handler: h2,
      });
      pipeline.register({
        id: "test:TurnStart:2",
        event: "TurnStart",
        handler: h3,
      });

      const result = await pipeline.run("TurnStart", makeCtx(), {
        choice: "none",
      });

      expect(result).toEqual({ action: "continue", replace: { choice: "a" } });
      expect(h3).not.toHaveBeenCalled();
    });

    it("stream hooks currently route through sequential chaining", async () => {
      HOOK_SEMANTICS.TurnStart = "stream";
      const h1 = vi
        .fn()
        .mockResolvedValue({ action: "continue", replace: { value: 2 } });
      const h2 = vi
        .fn()
        .mockImplementation(async (_ctx, payload: { value: number }) => ({
          action: "continue",
          replace: { value: payload.value + 1 },
        }));

      pipeline.register({
        id: "test:TurnStart:0",
        event: "TurnStart",
        handler: h1,
      });
      pipeline.register({
        id: "test:TurnStart:1",
        event: "TurnStart",
        handler: h2,
      });

      const result = await pipeline.run("TurnStart", makeCtx(), { value: 1 });

      expect(result).toEqual({ action: "continue", replace: { value: 3 } });
      expect(h2).toHaveBeenCalledWith(expect.anything(), { value: 2 });
    });
  });

  describe("abort semantics", () => {
    it("stops the chain immediately on abort and returns abort result", async () => {
      const h1 = vi
        .fn()
        .mockResolvedValue({ action: "abort", reason: "blocked" });
      const h2 = vi.fn().mockResolvedValue({ action: "continue" });

      pipeline.register({
        id: "test:PreRuntime:0",
        event: "PreRuntime",
        handler: h1,
      });
      pipeline.register({
        id: "test:PreRuntime:1",
        event: "PreRuntime",
        handler: h2,
      });

      const result = await pipeline.run(
        "PreRuntime",
        makeCtx("PreRuntime"),
        {},
      );

      expect(result.action).toBe("abort");
      expect((result as { action: "abort"; reason: string }).reason).toBe(
        "blocked",
      );
      expect(h2).not.toHaveBeenCalled();
    });

    it("emits hook.aborted event to eventBus on abort", async () => {
      const bus = createEventBus();
      const emitted: string[] = [];
      bus.onEmit((e) => {
        emitted.push(e.type);
      });

      pipeline.register({
        id: "test:TurnStart:0",
        event: "TurnStart",
        handler: vi.fn().mockResolvedValue({ action: "abort", reason: "stop" }),
      });

      await pipeline.run("TurnStart", makeCtx(), {}, { eventBus: bus });
      expect(emitted).toContain("hook.aborted");
    });

    it("observability payload carries hookId, hookPluginId, ctx.pluginId, reason (review I4)", async () => {
      const bus = createEventBus();
      const captured: Array<{
        type: string;
        payload: Record<string, unknown>;
      }> = [];
      bus.onEmit((e) => {
        captured.push({
          type: e.type,
          payload: e.payload as Record<string, unknown>,
        });
      });

      // Register as a plugin-scoped hook so reg.pluginId is defined.
      pipeline.register({
        id: "plugin-x:TurnStart:0",
        event: "TurnStart",
        pluginId: "plugin-x",
        handler: vi
          .fn()
          .mockResolvedValue({ action: "abort", reason: "policy-block" }),
      });

      // Context identity is a DIFFERENT plugin (the one being gated).
      await pipeline.run(
        "TurnStart",
        {
          event: "TurnStart",
          sessionId: "s1",
          turnId: "t1",
          pluginId: "plugin-narrator",
        },
        {},
        { eventBus: bus },
      );

      expect(captured).toHaveLength(1);
      const { type, payload } = captured[0];
      expect(type).toBe("hook.aborted");
      expect(payload.hookId).toBe("plugin-x:TurnStart:0");
      expect(payload.hookPluginId).toBe("plugin-x");
      expect(payload.pluginId).toBe("plugin-narrator");
      expect(payload.reason).toBe("policy-block");
      expect(payload.sessionId).toBe("s1");
      expect(payload.turnId).toBe("t1");
    });
  });

  describe("timeout", () => {
    it("aborts with timeout reason when handler exceeds timeoutMs", async () => {
      const slowHandler = vi
        .fn()
        .mockImplementation(
          () =>
            new Promise<HookResult<object>>((resolve) =>
              setTimeout(() => resolve({ action: "continue" }), 500),
            ),
        );

      pipeline.register({
        id: "test:PreRuntime:0",
        event: "PreRuntime",
        handler: slowHandler,
        timeoutMs: 10,
      });

      const result = await pipeline.run(
        "PreRuntime",
        makeCtx("PreRuntime"),
        {},
      );
      expect(result.action).toBe("abort");
      expect((result as { action: "abort"; reason: string }).reason).toContain(
        "timed out after",
      );
    });

    it("emits hook.timeout event to eventBus on timeout", async () => {
      const bus = createEventBus();
      const emitted: string[] = [];
      bus.onEmit((e) => {
        emitted.push(e.type);
      });

      pipeline.register({
        id: "test:TurnStart:0",
        event: "TurnStart",
        handler: vi.fn().mockImplementation(
          () =>
            new Promise(() => {
              /* never resolves */
            }),
        ),
        timeoutMs: 10,
      });

      await pipeline.run("TurnStart", makeCtx(), {}, { eventBus: bus });
      expect(emitted).toContain("hook.timeout");
    });
  });

  describe("thrown exception", () => {
    it("converts thrown exception to abort with error message", async () => {
      pipeline.register({
        id: "test:PreStateCommit:0",
        event: "PreStateCommit",
        handler: vi.fn().mockRejectedValue(new Error("something went wrong")),
      });

      const result = await pipeline.run(
        "PreStateCommit",
        makeCtx("PreStateCommit"),
        {},
      );
      expect(result.action).toBe("abort");
      expect((result as { action: "abort"; reason: string }).reason).toBe(
        "something went wrong",
      );
    });

    it("emits hook.error event to eventBus on thrown exception", async () => {
      const bus = createEventBus();
      const emitted: string[] = [];
      bus.onEmit((e) => {
        emitted.push(e.type);
      });

      pipeline.register({
        id: "test:PreStateCommit:0",
        event: "PreStateCommit",
        handler: vi.fn().mockRejectedValue(new Error("boom")),
      });

      await pipeline.run(
        "PreStateCommit",
        makeCtx("PreStateCommit"),
        {},
        { eventBus: bus },
      );
      expect(emitted).toContain("hook.error");
    });
  });

  describe("match filter", () => {
    it("skips handler when match filter returns false", async () => {
      const handler = vi.fn().mockResolvedValue({ action: "continue" });
      pipeline.register({
        id: "test:PreToolUse:0",
        event: "PreToolUse",
        handler,
        match: (p: unknown) => (p as { name?: string }).name === "special-tool",
      });

      await pipeline.run("PreToolUse", makeCtx("PreToolUse"), {
        name: "other-tool",
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it("runs handler when match filter returns true", async () => {
      const handler = vi.fn().mockResolvedValue({ action: "continue" });
      pipeline.register({
        id: "test:PreToolUse:0",
        event: "PreToolUse",
        handler,
        match: (p: unknown) => (p as { name?: string }).name === "special-tool",
      });

      await pipeline.run("PreToolUse", makeCtx("PreToolUse"), {
        name: "special-tool",
      });
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe("unregister", () => {
    it("removes a registered handler by id", async () => {
      const handler = vi.fn().mockResolvedValue({ action: "continue" });
      pipeline.register({
        id: "test:TurnStart:0",
        event: "TurnStart",
        handler,
      });
      pipeline.unregister("test:TurnStart:0");

      await pipeline.run("TurnStart", makeCtx(), {});
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("removes all registrations", async () => {
      const handler = vi.fn().mockResolvedValue({ action: "continue" });
      pipeline.register({
        id: "test:TurnStart:0",
        event: "TurnStart",
        handler,
      });
      pipeline.clear();

      await pipeline.run("TurnStart", makeCtx(), {});
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("all 8 HookEvent types have working emit sites", () => {
    const events: HookEvent[] = [
      "TurnStart",
      "PreRuntime",
      "PostRuntime",
      "PreToolUse",
      "PostToolUse",
      "PreStateCommit",
      "PostStateCommit",
      "TurnStop",
    ];

    for (const event of events) {
      it(`runs handlers for ${event}`, async () => {
        const handler = vi.fn().mockResolvedValue({ action: "continue" });
        pipeline.register({ id: `test:${event}:0`, event, handler });

        await pipeline.run(event, makeCtx(event), { event });
        expect(handler).toHaveBeenCalledOnce();
      });
    }
  });
});
