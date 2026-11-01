/**
 * Hooks fire once per logical runtime, however many times it suspends:
 * PreRuntime at the original dispatch, PostRuntime at the real end with
 * `resumed: true`. Each run still reports its own start and terminal.
 */

import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import type {
  RuntimeManifest,
  RuntimeResult,
  SubscriptionEvent,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import { createMemoryStore } from "@covel/store/memory";
import { suspendTool } from "@covel/tools";
import {
  commitExecution,
  createHookPipeline,
  createTraceRecorder,
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/index.js";
import type { ExecutionDeps } from "../src/execution.js";
import {
  makeExecutor,
  prose,
  queuedLLM,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

const SESSION = "session";
const timestamp = "2026-10-29T00:00:00.000Z";
const input = {
  sessionId: SESSION,
  turnId: "player-turn",
  logicalTurnId: "logical-player-turn",
  playerMessage: "Ask",
  origin: "player" as const,
};
const ASK = {
  reason: "Need input",
  fields: [{ type: "text", name: "answer", label: "Answer" }],
};

describe.each(["agent", "function"] as const)(
  "a %s that suspends twice",
  (runtimeType) => {
    it("runs PreRuntime and PostRuntime once for the logical runtime", async () => {
      const store = createMemoryStore();
      await store.createSession({
        id: SESSION,
        locale: "en-US",
        status: "active",
        phase: "playing",
        setupRuntimes: {},
        seats: [
          {
            id: "main",
            controller: "human",
            role: "player",
            characters: "auto",
          },
        ],
        activePlugins: ["probe"],
        completedPlayerTurns: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const runtime: RuntimeManifest = {
        description: "test",
        name: "probe/asker",
        pluginId: "probe",
        runtimeType,
        stage: "post-turn",
        outputKind: "system",
        trigger: { type: "auto" },
        ...(runtimeType === "agent" ? { tools: { builtin: ["suspend"] } } : {}),
      };
      const hookPipeline = createHookPipeline();
      const pre = vi.fn(async () => ({ action: "continue" as const }));
      const posted: { result: RuntimeResult; resumed?: boolean }[] = [];
      hookPipeline.register({ id: "pre", event: "PreRuntime", handler: pre });
      hookPipeline.register({
        id: "post",
        event: "PostRuntime",
        handler: async (_context, payload) => {
          posted.push(
            structuredClone(
              payload as { result: RuntimeResult; resumed?: boolean },
            ),
          );
          return { action: "continue" };
        },
      });
      const eventBus = createEventBus();
      const events: SubscriptionEvent[] = [];
      eventBus.onEmit((event) => events.push(event));
      const trace = createTraceRecorder(store, SESSION, input.turnId);
      const completed = vi.fn(trace.runtimeCompleted);

      let leg = 0;
      const deps = (): ExecutionDeps => ({
        store,
        eventBus,
        hookPipeline,
        onRuntimeStart: trace.runtimeStarted,
        onRuntimeComplete: completed,
        llm: queuedLLM(
          leg === 2
            ? [prose("All answered.")]
            : [toolCall("suspend", ASK, `call-${leg}`)],
        ),
        toolExecutor: makeExecutor([suspendTool]),
        loadRuntime: async (manifest): Promise<LoadedRuntime> => ({
          manifest,
          promptTemplate: "Ask.",
          handler: async () =>
            leg === 2
              ? { outcome: "success", value: { content: "All answered." } }
              : {
                  outcome: "suspended",
                  reason: `question ${leg}`,
                  resumeSchema: { type: "object" },
                },
        }),
      });

      try {
        const execution = await executeTurn(input, [runtime], deps());
        await commitExecution({
          store,
          eventBus,
          execution,
          completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
        });
        for (leg = 1; leg <= 2; leg++) {
          const [suspension] = (await store.listSuspensions(SESSION)).filter(
            (record) => record.resolvedAt === undefined,
          );
          const resumed = await resumeSuspendedRuntime(
            suspension!,
            {},
            runtime,
            deps(),
          );
          expect(resumed.result.status).toBe(
            leg === 2 ? "success" : "suspended",
          );
          const outcome = await commitExecution({
            store,
            eventBus,
            execution: resumed,
            completion: {
              kind: "resume",
              turnId: suspension!.turnId,
              suspensionId: suspension!.id,
              pluginId: suspension!.pluginId,
              runtimeId: suspension!.runtimeId,
            },
          });
          expect(outcome.status).toBe("committed");
        }

        expect(pre).toHaveBeenCalledTimes(1);
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({
          resumed: true,
          result: { status: "success" },
        });

        const started = events
          .filter((event) => event.type === "runtime.started")
          .map(
            (event) => event.payload as { runId: string; resumed?: boolean },
          );
        expect(started).toHaveLength(3);
        expect(new Set(started.map((event) => event.runId)).size).toBe(3);
        expect(started[0]).not.toHaveProperty("resumed");
        expect(started.slice(1)).toEqual([
          expect.objectContaining({ resumed: true }),
          expect.objectContaining({ resumed: true }),
        ]);
        // Each invocation finalizes once. Commit-time corrections update the
        // saved invocation's lifecycle without replaying execution or hooks.
        expect(completed.mock.calls.map(([info]) => info.status)).toEqual([
          "suspended",
          "suspended",
          "success",
        ]);
        const terminals = events
          .filter((event) => event.type === "runtime.completed")
          .map((event) => {
            const { runId, status } = event.payload as {
              runId: string;
              status: string;
            };
            return { runId, status };
          });
        expect(terminals).toEqual([
          { runId: started[0]!.runId, status: "suspended" },
          { runId: started[1]!.runId, status: "suspended" },
          { runId: started[2]!.runId, status: "success" },
          { runId: started[1]!.runId, status: "success" },
        ]);
      } finally {
        await eventBus.close();
      }
    });
  },
);
