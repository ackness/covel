import { describe, expect, it } from "vitest";
import { z, tool, withModelView } from "@covel/tools";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";

describe("explicit tool model views", () => {
  it.each(["opaque-handle", "A compact summary"])(
    "preserves an intentional summary verbatim: %s",
    async (summary) => {
      const content = { private: "code only", ui: [{ parts: [] }] };
      const command = tool({
        name: "view",
        description: "View",
        parameters: z.object({}),
        execute: async () => withModelView(content, { summary }),
      });
      const executor = createToolExecutor({ findTool: () => command });
      try {
        const result = await executor.execute(
          { toolCallId: "c", name: "view", arguments: "{}" },
          { sessionId: "s", turnId: "t", pluginId: "p", runtimeId: "p/r" },
        );
        expect(result.result).toBe(JSON.stringify({ summary }));
        expect(result.parsedResult).toEqual(content);
      } finally {
        await executor.close();
      }
    },
  );
  it("treats a former magic field as ordinary content", async () => {
    const command = tool({
      name: "view",
      description: "View",
      parameters: z.object({}),
      execute: async () => ({ _text: "ordinary data" }),
    });
    const executor = createToolExecutor({ findTool: () => command });
    try {
      const result = await executor.execute(
        { toolCallId: "c", name: "view", arguments: "{}" },
        { sessionId: "s", turnId: "t", pluginId: "p", runtimeId: "p/r" },
      );
      expect(JSON.parse(result.result)).toEqual({
        data: { _text: "ordinary data" },
      });
    } finally {
      await executor.close();
    }
  });
});
