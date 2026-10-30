/**
 * ToolExecutor + ApprovalPipeline integration tests.
 *
 * Verifies:
 * 1. Whitelisted tools (builtin + known local) execute without approval
 * 2. Exact-name denies take precedence over source-wide allows
 * 3. approvalStatus is correctly recorded in store
 * 4. An omitted approval capability auto-allows tools
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import type {
  ToolCall,
  ToolCallContext,
} from "../src/agent-loop/tool-executor.js";
import {
  createApprovalPipeline,
  createDefaultToolApprovalPipeline,
} from "@covel/approval";
import type { PermissionRule } from "@covel/approval";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import { tool, ToolRegistry } from "@covel/tools";
import { z } from "zod";

// ── Test tools ──────────────────────────────────────────────────

const echoTool = tool({
  name: "echo",
  description: "Echo back the input",
  parameters: z.object({ message: z.string() }),
  execute: async (params) => ({ echoed: params.message }),
});

const dangerousTool = tool({
  name: "dangerous-action",
  description: "A hypothetical dangerous tool",
  parameters: z.object({ target: z.string() }),
  execute: async (params) => ({ deleted: params.target }),
});

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { toolCallId: `call-${name}`, name, arguments: JSON.stringify(args) };
}

const ctx: ToolCallContext = {
  sessionId: "sess-1",
  turnId: "turn-1",
  pluginId: "test-plugin",
  runtimeId: "test-rt",
};

// ── Tests ───────────────────────────────────────────────────────

describe("ToolExecutor with ApprovalPipeline", () => {
  let store: DataStore;

  beforeEach(() => {
    store = createMemoryStore();
  });

  describe("custom policy: builtin + local allowed, named tool denied", () => {
    const rules: readonly PermissionRule[] = [
      { pattern: "dangerous-action", action: "deny" },
      { pattern: "builtin:*", action: "allow" },
      { pattern: "local:*", action: "allow" },
    ];

    it("should execute whitelisted builtin tool", async () => {
      const approval = createApprovalPipeline(rules);
      const executor = createToolExecutor({
        findTool: (name) => (name === "echo" ? echoTool : undefined),
        store,
        approval,
        getToolSource: () => "builtin",
      });

      const result = await executor.execute(
        makeCall("echo", { message: "hi" }),
        ctx,
      );
      expect(result.success).toBe(true);
      expect(result.parsedResult).toEqual({ echoed: "hi" });
    });

    it("should execute whitelisted local tool", async () => {
      const approval = createApprovalPipeline(rules);
      const executor = createToolExecutor({
        findTool: (name) => (name === "echo" ? echoTool : undefined),
        store,
        approval,
        getToolSource: () => "local",
      });

      const result = await executor.execute(
        makeCall("echo", { message: "hi" }),
        ctx,
      );
      expect(result.success).toBe(true);
    });

    it("should deny a local tool by exact name before source-wide allow", async () => {
      const approval = createApprovalPipeline(rules);
      const executor = createToolExecutor({
        findTool: (name) =>
          name === "dangerous-action" ? dangerousTool : undefined,
        store,
        approval,
        getToolSource: () => "local",
      });

      const result = await executor.execute(
        makeCall("dangerous-action", { target: "world" }),
        ctx,
      );
      expect(result.success).toBe(false);
      expect(result.result).toContain("denied");
    });

    it("should record correct approvalStatus in store", async () => {
      const approval = createApprovalPipeline(rules);
      const executor = createToolExecutor({
        findTool: (name) => (name === "echo" ? echoTool : undefined),
        store,
        approval,
        getToolSource: () => "builtin",
      });

      await executor.execute(makeCall("echo", { message: "test" }), ctx);
      const calls = await store.listToolCalls("sess-1");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.approvalStatus).toBe("auto-allowed");
    });

    it("should record denied status in store", async () => {
      const approval = createApprovalPipeline(rules);
      const executor = createToolExecutor({
        findTool: (name) =>
          name === "dangerous-action" ? dangerousTool : undefined,
        store,
        approval,
        getToolSource: () => "local",
      });

      await executor.execute(
        makeCall("dangerous-action", { target: "x" }),
        ctx,
      );
      const calls = await store.listToolCalls("sess-1");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.approvalStatus).toBe("policy-denied");
    });
  });

  it("uses registry provenance with the default policy and still rejects unresolved tools", async () => {
    const registry = new ToolRegistry();
    registry.registerBuiltin(
      tool({
        name: "create-form",
        description: "Synthetic framework tool",
        parameters: z.object({ message: z.string() }),
        execute: async (params) => ({ echoed: params.message }),
      }),
    );
    registry.registerPlugin(ctx.pluginId, echoTool);
    registry.registerPlugin("other-plugin", dangerousTool);
    const executor = createToolExecutor({
      findTool: (name, context) => registry.find(name, context.pluginId),
      getToolSource: (name) => registry.source(name),
      approval: createDefaultToolApprovalPipeline(),
      store,
    });
    try {
      for (const name of ["create-form", "echo"]) {
        const result = await executor.execute(
          makeCall(name, { message: "ok" }),
          ctx,
        );
        expect(result.success).toBe(true);
        expect(result.approvalStatus).toBe("auto-allowed");
      }
      for (const name of ["dangerous-action", "missing-tool"]) {
        const result = await executor.execute(
          makeCall(name, { target: "world" }),
          ctx,
        );
        expect(result.success).toBe(false);
        expect(JSON.parse(result.result)).toMatchObject({
          error: { code: "not-found" },
        });
      }
    } finally {
      await executor.close();
    }
  });

  describe("without an approval pipeline", () => {
    it("should auto-allow all tools when no approval configured", async () => {
      const executor = createToolExecutor({
        findTool: (name) => (name === "echo" ? echoTool : undefined),
        store,
      });

      const result = await executor.execute(
        makeCall("echo", { message: "unconfigured" }),
        ctx,
      );
      expect(result.success).toBe(true);

      const calls = await store.listToolCalls("sess-1");
      expect(calls[0]!.approvalStatus).toBe("auto-allowed");
    });
  });

  describe("exact tool name whitelist", () => {
    const rules: readonly PermissionRule[] = [
      { pattern: "echo", action: "allow" },
      { pattern: "local:*", action: "deny" },
    ];

    it("should allow explicitly whitelisted tool by name", async () => {
      const approval = createApprovalPipeline(rules);
      const executor = createToolExecutor({
        findTool: (name) => (name === "echo" ? echoTool : undefined),
        store,
        approval,
        getToolSource: () => "local",
      });

      const result = await executor.execute(
        makeCall("echo", { message: "ok" }),
        ctx,
      );
      expect(result.success).toBe(true);
    });
  });
});
