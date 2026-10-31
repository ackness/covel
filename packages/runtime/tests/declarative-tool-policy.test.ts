import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  discoverPluginAt,
  loadPluginDefinition,
  loadRuntime,
  resolvePluginRuntimeManifest,
} from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import {
  FRAMEWORK_TOOL_NAMES,
  FRAMEWORK_TOOL_CAPABILITIES,
} from "@covel/shared";
import { tool, z } from "@covel/tools";
import { createHookPipeline } from "../src/index.js";
import { runPreToolUseHook } from "../src/hooks/wire-helpers.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import {
  prepareAgentToolSurface,
  withAgentToolSurface,
} from "../src/agent-loop/agent-tool-surface.js";

it("reviews every current framework tool explicitly, including validated character writes", () => {
  expect(Object.keys(FRAMEWORK_TOOL_CAPABILITIES).sort()).toEqual(
    [...FRAMEWORK_TOOL_NAMES].sort(),
  );
  expect(FRAMEWORK_TOOL_CAPABILITIES["sync-characters"]).toBe(
    "character-write",
  );
});
it.each([false, true])(
  "enforces the final tool name after hooks using the real package profile (rewrite=%s)",
  async (rewrite) => {
    const root = path.resolve(
      import.meta.dirname,
      "../../../tests/third-party/declarative-notebook",
    );
    const discovery = (await discoverPluginAt(root))!;
    const definition = await loadPluginDefinition(discovery);
    const manifest = resolvePluginRuntimeManifest(
      definition,
      definition.manifests[0]!.manifest,
    );
    const loaded = await loadRuntime(
      discovery,
      manifest.name,
      "en",
      definition,
    );
    expect(loaded.executionMode).toBe("declarative");
    const store = createMemoryStore();
    const invoked = vi.fn(async () => ({ secret: "must not execute" }));
    const unreviewed = tool({
      name: "unreviewed-write",
      description: "A future builtin",
      parameters: z.object({}),
      execute: invoked,
    });
    const hooks = createHookPipeline();
    if (rewrite)
      hooks.register({
        id: "rewrite",
        event: "PreToolUse",
        handler: async () => ({
          action: "continue",
          replace: { toolCall: { name: "unreviewed-write", arguments: "{}" } },
        }),
      });
    const raw = createToolExecutor({
      store,
      findTool: (name) => (name === unreviewed.name ? unreviewed : undefined),
    });
    const surface = await prepareAgentToolSurface({
      manifest,
      input: { sessionId: "session" },
      deps: { loadRuntime: async () => loaded },
    });
    const executor = withAgentToolSurface(raw, surface, undefined);
    const context = {
      sessionId: "session",
      turnId: "turn",
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      authorizedToolNames: new Set([
        "notes-list",
        "notes-upsert",
        "unreviewed-write",
      ]),
    };
    try {
      const before = {
        id: "deny",
        name: rewrite ? "notes-list" : "unreviewed-write",
        arguments: "{}",
      };
      const after = await runPreToolUseHook(
        {
          pipeline: hooks,
          sessionId: "session",
          turnId: "turn",
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
        },
        before,
      );
      if (after.skipped)
        throw new Error("The hook must rewrite and reach final dispatch");
      expect(after.toolCall.name).toBe("unreviewed-write");
      const denied = await executor.execute(
        {
          toolCallId: after.toolCall.id,
          name: after.toolCall.name,
          arguments: after.toolCall.arguments,
        },
        context,
      );
      expect(denied.success).toBe(false);
      expect(denied.result).toContain("not declared");
      expect(invoked).not.toHaveBeenCalled();
      const allowed = await executor.execute(
        {
          toolCallId: "own",
          name: "notes-upsert",
          arguments: JSON.stringify({
            record: { id: "public", text: "Public note" },
          }),
        },
        context,
      );
      expect(allowed.success, allowed.result).toBe(true);
      expect(allowed.pendingProposals).toContainEqual(
        expect.objectContaining({
          type: "plugin.data.update",
          source: expect.objectContaining({ pluginId: manifest.pluginId }),
          payload: expect.objectContaining({ namespace: "notes" }),
        }),
      );
      const code = withAgentToolSurface(
        raw,
        { ...surface, declarative: false },
        undefined,
      );
      expect(
        (
          await code.execute(
            { toolCallId: "code", name: "unreviewed-write", arguments: "{}" },
            context,
          )
        ).success,
      ).toBe(true);
      expect(invoked).toHaveBeenCalledOnce();
    } finally {
      await raw.close();
      await store.close();
    }
  },
);
