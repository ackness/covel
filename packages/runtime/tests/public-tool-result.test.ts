import { describe, expect, it } from "vitest";
import {
  makeProposal,
  withEmittedEvents,
  withPendingProposals,
  type PluginToolResult,
} from "@covel/plugin-handlers-utils";
import { tool, z } from "@covel/tools";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";

const context = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "notebook",
  runtimeId: "notebook/write",
};

describe("public SDK results through the real host executor", () => {
  it.each(["literal", "spread", "clone", "json"])(
    "extracts %s content and writes without private host metadata",
    async (copy) => {
      const proposal = makeProposal(
        context,
        "2026-09-29T00:00:00.000Z",
        "plugin.data",
        { namespace: "notes", key: "current", value: "remember" },
      );
      const event = { topic: "notebook.saved", data: { key: "current" } };
      const saveNote = tool({
        name: "save-note",
        description: "Save a note",
        parameters: z.object({}),
        async execute() {
          const result: PluginToolResult<{ saved: boolean }> = {
            kind: "covel.tool-result",
            content: { saved: true },
            pendingProposals: [proposal],
            emittedEvents: [event],
          };
          const wrapped = withPendingProposals(
            withEmittedEvents(Object.freeze({ saved: true }), [event]),
            [proposal],
          );
          if (copy === "literal") return result;
          if (copy === "spread") return { ...wrapped };
          if (copy === "clone") return structuredClone(wrapped);
          return JSON.parse(JSON.stringify(wrapped)) as typeof wrapped;
        },
      });
      const executor = createToolExecutor({ findTool: () => saveNote });
      const result = await executor.execute(
        { toolCallId: "call", name: "save-note", arguments: "{}" },
        context,
      );
      expect(result.success).toBe(true);
      expect(result.parsedResult).toEqual({ saved: true });
      expect(result.result).toBe('{"saved":true}');
      expect(result.pendingProposals).toEqual([proposal]);
      expect(result.emittedEvents).toEqual([event]);
    },
  );
});
