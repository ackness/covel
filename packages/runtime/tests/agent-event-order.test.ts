import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeResult } from "@covel/shared";
import { suspendTool, tool, z } from "@covel/tools";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import { resumeRuntimePipeline } from "../src/resume/turn-resume.js";
import { collectExecutionSuspensions } from "../src/suspension-artifact.js";
import { runEventChain } from "../src/trigger/turn-event-chain.js";
import {
  input,
  makeExecutor,
  manifest,
  queuedLLM,
  submitted,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

describe("submitted business-tool event order", () => {
  it.each([false, true])(
    "delivers the first tool's payload through the event chain (resumed: %s)",
    async (resumed) => {
      const store = createMemoryStore();
      try {
        const rt = manifest({
          trigger: { type: "manual" },
          tools: { plugin: ["first", "second"], builtin: ["suspend"] },
        });
        const modules = [1, 2].map((value) =>
          tool({
            name: value === 1 ? "first" : "second",
            description: "emit a change",
            parameters: z.object({}),
            async execute() {
              return {
                events: [
                  { topic: "changed", data: { value } },
                  { topic: `changed-${value}`, data: { value } },
                ],
              };
            },
          }),
        );
        const before = toolCall("first", {}, "first");
        const after = [toolCall("second", {}, "second"), submitted("done")];
        const deps = {
          store,
          toolExecutor: makeExecutor([...modules, suspendTool]),
          loadRuntime: async () => ({
            manifest: rt,
            promptTemplate: "Emit changes, then submit.",
          }),
          llm: queuedLLM(
            resumed
              ? [
                  before,
                  toolCall(
                    "suspend",
                    {
                      reason: "Continue?",
                      fields: [
                        { type: "text", name: "answer", label: "Answer" },
                      ],
                    },
                    "suspend",
                  ),
                ]
              : [before, ...after],
          ),
        };
        const turn = await runTurnPipeline(
          { ...input, origin: "manual", manualTrigger: { runtimeId: rt.name } },
          [rt],
          deps,
        );
        let result = turn.runtimeResults[0]!;
        if (resumed) {
          expect(result.status).toBe("suspended");
          const [record] = collectExecutionSuspensions(turn);
          if (!record) throw new Error("expected a suspension");
          result = await resumeRuntimePipeline(record, {}, rt, {
            ...deps,
            llm: queuedLLM(after),
          });
        }
        expect(result.status).toBe("success");
        expect(result.effects?.events).toEqual([
          { topic: "changed", data: { value: 1 } },
          { topic: "changed-1", data: { value: 1 } },
          { topic: "changed", data: { value: 2 } },
          { topic: "changed-2", data: { value: 2 } },
        ]);
        const subscriber = manifest({
          name: "plug/subscriber",
          trigger: { type: "event", topic: "changed" },
        });
        const delivered: unknown[] = [];
        const dropped: string[] = [];
        await runEventChain({
          activeRuntimes: [subscriber],
          completedResults: new Map([[rt.name, result]]),
          executeRuntime: async (runtime, event): Promise<RuntimeResult> => {
            delivered.push(event?.data);
            return { ...result, runtimeId: runtime.name, effects: undefined };
          },
          sessionId: input.sessionId,
          turnId: input.turnId,
          turnNumber: 1,
          logicalTurn: 1,
          setupRuntimes: {},
          onDroppedEvent: (topic) => dropped.push(topic),
        });
        expect(delivered).toEqual([{ value: 1 }]);
        expect(dropped).toEqual(["changed"]);
      } finally {
        await store.close();
      }
    },
  );
});
