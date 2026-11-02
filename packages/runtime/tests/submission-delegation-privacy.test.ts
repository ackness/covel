import { describe, expect, it, vi } from "vitest";
import { CHARACTER_ACTOR_CONTRACT, type LLMAdapter } from "@covel/shared";
import { tool, z } from "@covel/tools";
import { createHookPipeline, createTurnEmitter } from "../src/index.js";
import {
  fixture,
  fn,
  input,
  SESSION,
  story,
  tell,
} from "./_helpers/world-read-fixture.js";
import { submitted, toolCall } from "./_helpers/agent-loop-fixture.js";

describe("rejected submission batches preserve delegation privacy", () => {
  for (const name of ["delegate", "delegate-batch"] as const) {
    for (const privateKind of ["actor", "concealed"] as const) {
      it.each([false, true])(
        `${name} to ${privateKind} stays private (rewritten with tracing: %s)`,
        async (rewrite) => {
          const secret = "PRIVATE-BRIEF-SENTINEL";
          const work = vi.fn(async () => ({ observed: true }));
          const observe = tool({
            name: "observe",
            description: "Observe",
            parameters: z.object({}),
            execute: work,
          });
          const f = await fixture({ tools: [observe] });
          const parent = fn("parent", {
            runtimeType: "agent",
            tools: { builtin: [name], plugin: ["observe"] },
          });
          const child = fn("private-child", {
            runtimeType: "agent",
            subagentOnly: true,
            stage: undefined,
            trigger: { type: "manual" },
            ...(privateKind === "actor"
              ? { outputContract: CHARACTER_ACTOR_CONTRACT }
              : { concealed: true }),
          });
          const request = {
            target: { runtimeId: child.name },
            brief: secret,
            character: "source",
          };
          const privateCall = toolCall(
            name,
            name === "delegate-batch" ? { requests: [request] } : request,
            "private-call",
          ).toolCalls[0]!;
          const originalCall = rewrite
            ? toolCall("observe", {}, "private-call").toolCalls[0]!
            : privateCall;
          const responses = [
            {
              ...submitted("premature"),
              toolCalls: [
                originalCall,
                ...toolCall("observe", {}, "business-call").toolCalls,
                ...submitted("premature").toolCalls,
              ],
            },
            submitted("done"),
          ];
          const generate = vi.fn<LLMAdapter["generate"]>(
            async () => responses.shift() ?? submitted("unexpected child"),
          );
          const hooks = createHookPipeline();
          if (rewrite)
            hooks.register({
              id: "rewrite-private-target",
              event: "PreToolUse",
              handler: async (_ctx, payload) => {
                const call = (payload as { toolCall: { id: string } }).toolCall;
                return call.id === "private-call"
                  ? { action: "continue", replace: { toolCall: privateCall } }
                  : { action: "continue" };
              },
            });
          const emitter = rewrite
            ? createTurnEmitter({
                store: f.store,
                eventBus: f.eventBus,
                sessionId: SESSION,
                turnId: input.turnId,
              })
            : undefined;
          const result = await f.execute(
            [story, parent, child],
            { [story.name]: tell },
            {
              deps: { llm: { generate }, hookPipeline: hooks, emitter },
            },
          );
          expect(result.resultOf(parent).status).toBe("success");
          expect(generate).toHaveBeenCalledTimes(2);
          expect(work).not.toHaveBeenCalled();
          const record = result
            .resultOf(parent)
            .toolCalls.find((call) => call.toolCallId === "private-call");
          expect(record).toMatchObject({ input: null, output: null });
          expect(JSON.stringify(result.results)).not.toContain(secret);
          const persisted = await f.store.listTurnResults(SESSION);
          expect(persisted.length).toBeGreaterThan(0);
          expect(JSON.stringify(persisted)).not.toContain(secret);
          expect(await f.store.listToolCalls(SESSION)).toEqual([]);
          const traces = (await f.store.listTraceEvents(SESSION)).filter(
            (trace) => trace.turnId === input.turnId,
          );
          if (rewrite) {
            expect(traces.some((trace) => trace.type === "hook.rewrote")).toBe(
              true,
            );
            expect(traces).toContainEqual(
              expect.objectContaining({
                type: "tool.calling",
                payload: expect.objectContaining({
                  toolCallId: "private-call",
                }),
              }),
            );
          } else expect(traces).toEqual([]);
          expect(JSON.stringify(traces)).not.toContain(secret);
        },
      );
    }
  }
});
