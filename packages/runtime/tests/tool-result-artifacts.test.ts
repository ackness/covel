import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store";
import { tool, withPendingProposals, withEmittedEvents } from "@covel/tools";
import type { Proposal } from "@covel/shared";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";

describe("tool result artifact composition", () => {
  it.each(["frozen", "scalar", "array"])(
    "retains events and proposals for %s results in both wrapper orders",
    async (shape) => {
      const proposal: Proposal = {
        id: "proposal",
        type: "plugin.data",
        source: { pluginId: "probe", runtimeId: "probe/main" },
        sessionId: "session",
        turnId: "turn",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { namespace: "probe", key: "saved", value: true },
      };
      const events = [{ topic: "probe.changed", data: { changed: true } }];
      for (const reverse of [false, true]) {
        const result =
          shape === "frozen"
            ? Object.freeze({ saved: true })
            : shape === "array"
              ? Object.freeze([1, 2])
              : 7;
        const wrapped = reverse
          ? withPendingProposals(withEmittedEvents(result, events), [proposal])
          : withEmittedEvents(withPendingProposals(result, [proposal]), events);
        const operation = tool({
          name: "compose",
          description: "Compose artifacts",
          parameters: z.object({}),
          execute: async () => wrapped,
        });
        const store = createMemoryStore();
        const executor = createToolExecutor({
          findTool: () => operation,
          store,
        });
        const executed = await executor.execute(
          { toolCallId: "call", name: "compose", arguments: "{}" },
          {
            sessionId: "session",
            turnId: "turn",
            pluginId: "probe",
            runtimeId: "probe/main",
          },
        );
        expect(executed.success).toBe(true);
        expect(executed.pendingProposals).toEqual([proposal]);
        expect(executed.emittedEvents).toEqual(events);
        expect(executed.result).not.toContain("proposal");
        await executor.close();
        await store.close();
      }
    },
  );
});
