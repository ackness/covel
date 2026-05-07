/**
 * Hook pipeline emitter integration tests.
 *
 * Verifies that HookPipeline.run() fans out `hook.fired`, `hook.rewrote`, and
 * `hook.aborted` into the TurnEmitter so the /debug timeline can render every
 * hook invocation without reaching into the eventBus wire.
 */

import { describe, it, expect } from "vitest";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { runPreToolUseHook } from "../src/hooks/wire-helpers.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";

describe("HookPipeline emitter integration", () => {
  it("does not emit any hook.* event when no handlers are registered", async () => {
    const emitter = makeEmitterSpy();
    const pipeline = createHookPipeline();

    await pipeline.run(
      "PreStateCommit",
      { event: "PreStateCommit", sessionId: "S", turnId: "T" },
      { proposal: { id: "p1", type: "state.patch" } },
      { emitter },
    );

    expect(emitter.events).toHaveLength(0);
  });

  it("emits hook.fired for each handler invoked", async () => {
    const emitter = makeEmitterSpy();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "hook-a",
      event: "PreStateCommit",
      handler: async () => ({ action: "continue" }),
    });

    await pipeline.run(
      "PreStateCommit",
      { event: "PreStateCommit", sessionId: "S", turnId: "T" },
      { proposal: { id: "p1" } },
      { emitter },
    );

    const fired = emitter.events.find((e) => e.type === "hook.fired");
    expect(fired).toBeDefined();
    expect(fired!.payload).toMatchObject({
      event: "PreStateCommit",
      hookName: "hook-a",
      targetId: "p1",
      targetType: "proposal",
    });
  });

  it("emits hook.rewrote when handler returns replace", async () => {
    const emitter = makeEmitterSpy();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "hook-b",
      event: "PreStateCommit",
      handler: async () => ({
        action: "continue",
        replace: { proposal: { id: "p1", mutated: true } },
      }),
    });

    await pipeline.run(
      "PreStateCommit",
      { event: "PreStateCommit", sessionId: "S", turnId: "T" },
      { proposal: { id: "p1" } },
      { emitter },
    );

    const rewrote = emitter.events.find((e) => e.type === "hook.rewrote");
    expect(rewrote).toBeDefined();
    expect(rewrote!.payload).toMatchObject({
      event: "PreStateCommit",
      hookName: "hook-b",
    });
    expect(rewrote!.payload.diff).toBeDefined();
  });

  it("emits hook.aborted on abort", async () => {
    const emitter = makeEmitterSpy();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "hook-c",
      event: "PreStateCommit",
      handler: async () => ({ action: "abort", reason: "policy-no" }),
    });

    await pipeline.run(
      "PreStateCommit",
      {
        event: "PreStateCommit",
        sessionId: "S",
        turnId: "T",
        pluginId: "origin-plugin",
        runtimeId: "origin-plugin/main",
      },
      { proposal: { id: "p1", type: "state.patch" } },
      { emitter },
    );

    const aborted = emitter.events.find((e) => e.type === "hook.aborted");
    expect(aborted).toBeDefined();
    expect(aborted!.payload).toMatchObject({
      event: "PreStateCommit",
      hookName: "hook-c",
      reason: "policy-no",
      targetId: "p1",
      targetType: "proposal",
      // R3: proposalType is carried over from the pre-refactor inline trace write.
      proposalType: "state.patch",
      // R4: runtimeId flows from the HookContext the commit pipeline now populates.
      runtimeId: "origin-plugin/main",
    });
  });

  it("extracts targetId from toolCall.id for PreToolUse (production shape)", async () => {
    const emitter = makeEmitterSpy();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "hook-tool",
      event: "PreToolUse",
      handler: async () => ({ action: "continue" }),
    });

    await pipeline.run(
      "PreToolUse",
      {
        event: "PreToolUse",
        sessionId: "S",
        turnId: "T",
        pluginId: "p",
        runtimeId: "r",
      },
      // Production payload shape built by runPreToolUseHook: { toolCall: { id, name, arguments } }.
      { toolCall: { id: "tc-42", name: "foo", arguments: "{}" } },
      { emitter },
    );

    const fired = emitter.events.find((e) => e.type === "hook.fired");
    expect(fired!.payload).toMatchObject({
      event: "PreToolUse",
      targetId: "tc-42",
      targetType: "toolCall",
    });
  });

  it("receives the real production payload shape when invoked via runPreToolUseHook", async () => {
    // Regression test for the shape-drift bug fixed under R1: when a caller
    // goes through the real wire-helper (as turn-executor does in
    // production), the targetId must appear in the emitted hook.fired event.
    // Previously the helper read `toolCall.toolCallId` but the helper's
    // payload is `{ toolCall: { id, name, arguments } }`, so targetId was
    // always undefined in production trace rows.
    const emitter = makeEmitterSpy();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "hook-real-wire",
      event: "PreToolUse",
      pluginId: "plugin-x",
      handler: async () => ({ action: "continue" }),
    });

    await runPreToolUseHook(
      {
        pipeline,
        sessionId: "S",
        turnId: "T",
        pluginId: "plugin-x",
        runtimeId: "plugin-x/runtime",
        emitter,
      },
      { id: "call-real-1", name: "do-thing", arguments: '{"k":1}' },
    );

    const fired = emitter.events.find((e) => e.type === "hook.fired");
    expect(fired).toBeDefined();
    expect(fired!.payload).toMatchObject({
      event: "PreToolUse",
      hookName: "hook-real-wire",
      targetId: "call-real-1",
      targetType: "toolCall",
      runtimeId: "plugin-x/runtime",
    });
  });
});
