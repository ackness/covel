/**
 * ToolExecutor trace emission tests — covers tool.calling / tool.completed /
 * tool.failed across the 5 branches (success, not-found, refused, invalid-input,
 * invalid-input via Zod, and the emitter-absent backward-compatible path).
 */

import { describe, it, expect } from "vitest";
import { ZodError, z } from "zod";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import type { ToolCallContext } from "../src/agent-loop/tool-executor.js";
import { tool, ToolValidationError, withEmittedEvents } from "@covel/tools";
import type { ApprovalPipeline } from "@covel/approval";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";

const baseCtx: ToolCallContext = {
  sessionId: "sess",
  turnId: "turn",
  pluginId: "test-plugin",
  runtimeId: "test-plugin/main",
};

describe("ToolExecutor trace emissions", () => {
  it("emits tool.calling then tool.completed on success", async () => {
    const emitter = makeEmitterSpy();
    const mockTool = tool({
      name: "echo",
      description: "echo",
      parameters: z.unknown(),
      async execute(params: unknown) {
        return { echo: params };
      },
    });
    const executor = createToolExecutor({
      findTool: () => mockTool,
    });

    const res = await executor.execute(
      { toolCallId: "c1", name: "echo", arguments: '{"hi":1}' },
      { ...baseCtx, emitter },
    );

    expect(res.success).toBe(true);
    expect(emitter.events.map((e) => e.type)).toEqual([
      "tool.calling",
      "tool.completed",
    ]);
    expect(emitter.events[0]!.payload).toMatchObject({
      toolName: "echo",
      toolCallId: "c1",
      arguments: '{"hi":1}',
      source: "local",
      approvalStatus: "auto-allowed",
    });
    expect(emitter.events[1]!.payload).toMatchObject({
      toolName: "echo",
      success: true,
      approvalStatus: "auto-allowed",
    });
    expect(typeof emitter.events[1]!.payload.durationMs).toBe("number");
  });

  it("previews validated domain events immediately after tool completion", async () => {
    const emitter = makeEmitterSpy();
    const mockTool = tool({
      name: "emit-event",
      description: "emit",
      parameters: z.unknown(),
      async execute() {
        return withEmittedEvents({ _text: "emitted" }, [
          {
            topic: "stage.direction",
            data: { cues: [{ type: "stage.clear" }] },
          },
        ]);
      },
    });
    const executor = createToolExecutor({
      findTool: () => mockTool,
    });

    const res = await executor.execute(
      {
        toolCallId: "c-preview",
        name: "emit-event",
        arguments: "{}",
      },
      { ...baseCtx, emitter },
    );

    expect(res.success).toBe(true);
    expect(emitter.events.map((event) => event.type)).toEqual([
      "tool.calling",
      "tool.completed",
      "domain-event.previewed",
    ]);
    expect(emitter.events[2]!.payload).toMatchObject({
      runtimeId: "test-plugin/main",
      pluginId: "test-plugin",
      toolCallId: "c-preview",
      topic: "stage.direction",
      data: { cues: [{ type: "stage.clear" }] },
    });
  });

  it("emits tool.failed with not-found when tool missing", async () => {
    const emitter = makeEmitterSpy();
    const executor = createToolExecutor({ findTool: () => undefined });
    const res = await executor.execute(
      { toolCallId: "c2", name: "nope", arguments: "{}" },
      { ...baseCtx, emitter },
    );
    expect(res.success).toBe(false);
    expect(emitter.events).toHaveLength(1);
    expect(emitter.events[0]!.type).toBe("tool.failed");
    expect(emitter.events[0]!.payload).toMatchObject({
      code: "not-found",
      success: false,
    });
  });

  it("emits tool.failed with invalid-input when arguments are not valid JSON", async () => {
    const emitter = makeEmitterSpy();
    const executor = createToolExecutor({
      findTool: () =>
        tool({
          name: "x",
          description: "",
          parameters: z.unknown(),
          async execute() {
            return {};
          },
        }),
    });
    const res = await executor.execute(
      { toolCallId: "c3", name: "x", arguments: "{not json" },
      { ...baseCtx, emitter },
    );
    expect(res.success).toBe(false);
    expect(emitter.events[0]!.type).toBe("tool.failed");
    expect(emitter.events[0]!.payload.code).toBe("invalid-input");
  });

  it("runs a call whose arguments have one of the slips the parser settles", async () => {
    const emitter = makeEmitterSpy();
    const received: unknown[] = [];
    const approved: unknown[] = [];
    const executor = createToolExecutor({
      findTool: () =>
        tool({
          name: "x",
          description: "",
          parameters: z.unknown(),
          async execute(params: unknown) {
            received.push(params);
            return {};
          },
        }),
      // The approval check sees the arguments the call runs on.
      approval: {
        check: (request) => {
          approved.push(request.input);
          return { decision: "allow" };
        },
      } as ApprovalPipeline,
    });
    const expected = [
      { updates: [{ id: "morale", delta: -1 }] },
      { updates: [{ id: "trust", note: 'She calls him "keeper" now.' }] },
      { updates: [{ id: "trust", at: { place: "hut" } }, { id: "morale" }] },
    ];
    for (const args of [
      '{"updates":[{"id":"morale","delta":-1}]}]}',
      '{"updates":[{"id":"trust","note":"She calls him "keeper" now."}]}',
      '{"updates":[{"id":"trust","at":{"place":"hut"}, {"id":"morale"}]}',
    ]) {
      const res = await executor.execute(
        { toolCallId: "c4", name: "x", arguments: args },
        { ...baseCtx, emitter },
      );
      expect(res.success, args).toBe(true);
    }
    expect(received).toEqual(expected);
    expect(approved).toEqual(expected);
    expect(emitter.events.map((event) => event.type)).not.toContain(
      "tool.failed",
    );
  });

  it("emits tool.failed with refused when approval denies the call", async () => {
    const emitter = makeEmitterSpy();
    const mockTool = tool({
      name: "dangerous",
      description: "",
      parameters: z.unknown(),
      async execute() {
        return {};
      },
    });
    const approval: ApprovalPipeline = {
      check: () => ({ decision: "deny", reason: "explicit deny" }),
    };
    const executor = createToolExecutor({
      findTool: () => mockTool,
      approval,
    });

    const res = await executor.execute(
      { toolCallId: "c5", name: "dangerous", arguments: "{}" },
      { ...baseCtx, emitter },
    );
    expect(res.success).toBe(false);
    expect(emitter.events).toHaveLength(1);
    expect(emitter.events[0]!.type).toBe("tool.failed");
    expect(emitter.events[0]!.payload).toMatchObject({
      code: "refused",
      error: "explicit deny",
      approvalStatus: "policy-denied",
      success: false,
    });
  });

  it("emits tool.failed with invalid-input and details (dedup exercised)", async () => {
    const emitter = makeEmitterSpy();
    // Build a ZodError whose issues include two entries on the same path
    // so the dedup logic in tool-executor collapses them into one detail.
    const schema = z.object({ name: z.string() });
    let zodError: ZodError;
    try {
      schema.parse({ name: 123 });
      throw new Error("schema should have rejected");
    } catch (err) {
      if (err instanceof ZodError) {
        zodError = err;
      } else {
        throw err;
      }
    }
    // Duplicate the first issue to exercise dedup (same path, different message).
    const issues = (
      zodError! as unknown as {
        issues: Array<{
          path: (string | number)[];
          message: string;
          code?: string;
        }>;
      }
    ).issues;
    issues.push({ ...issues[0]!, message: "phantom duplicate on same path" });
    // Add a second distinct path so we end up with 2 deduped details total.
    issues.push({
      path: ["age"],
      message: "age is required",
      code: issues[0]!.code,
    });
    const validationError = new ToolValidationError(zodError!);

    const throwingTool = tool({
      name: "vx",
      description: "",
      parameters: z.unknown(),
      async execute() {
        throw validationError;
      },
    });
    const executor = createToolExecutor({
      findTool: () => throwingTool,
    });

    const res = await executor.execute(
      { toolCallId: "c6", name: "vx", arguments: '{"name":123}' },
      { ...baseCtx, emitter },
    );
    expect(res.success).toBe(false);
    expect(emitter.events.map((e) => e.type)).toEqual([
      "tool.calling",
      "tool.failed",
    ]);
    const failPayload = emitter.events[1]!.payload;
    expect(failPayload.code).toBe("invalid-input");
    expect(Array.isArray(failPayload.details)).toBe(true);
    // Dedup means only 2 unique paths survive (name + age), not 3 raw issues.
    expect((failPayload.details as string[]).length).toBe(2);
    // The model reads which fields to fix in the headline as well.
    const sent = JSON.parse(res.result) as { error: { message: string } };
    for (const detail of failPayload.details as string[])
      expect(sent.error.message).toContain(detail);
  });

  it("does not emit anything when emitter is absent", async () => {
    const mockTool = tool({
      name: "noop",
      description: "",
      parameters: z.unknown(),
      async execute() {
        return {};
      },
    });
    const executor = createToolExecutor({
      findTool: () => mockTool,
    });
    const res = await executor.execute(
      { toolCallId: "c4", name: "noop", arguments: "{}" },
      baseCtx,
    );
    expect(res.success).toBe(true);
    // No crash — backward-compatible path
  });
});
