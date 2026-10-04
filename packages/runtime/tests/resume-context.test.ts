/**
 * A resumed runtime continues its source turn: it keeps that turn's content
 * locale and numeric clock, and reads the World Model like any other run.
 */

import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeManifest } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  runtimeDoneTool,
  suspendTool,
  tool,
  worldDimensionListTool,
  z,
} from "@covel/tools";
import {
  commitExecution,
  createHookPipeline,
  createToolExecutor,
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/index.js";

const timestamp = "2026-10-04T00:00:00.000Z";
const sessionId = "session";
const turnInput = {
  sessionId,
  turnId: "player-turn",
  playerMessage: "continue",
  origin: "player" as const,
  locale: "zh-CN",
};

async function seededStore() {
  const store = createMemoryStore();
  await store.createSession({
    id: sessionId,
    locale: "zh-CN",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: ["probe"],
    completedPlayerTurns: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await store.upsertCharacter({
    id: "npc",
    sessionId,
    name: "Keeper",
    type: "npc",
    fields: {},
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return store;
}

/** Commit the suspended turn, then let the session count other turns. */
async function suspendThenAdvance(
  store: Awaited<ReturnType<typeof seededStore>>,
  execution: Awaited<ReturnType<typeof executeTurn>>,
) {
  expect(execution.result.runtimeResults[0]?.status).toBe("suspended");
  const outcome = await commitExecution({
    store,
    execution,
    completion: { kind: "turn", turnId: turnInput.turnId, durationMs: 0 },
  });
  expect(outcome.status).toBe("committed");
  await store.updateSession(sessionId, { completedPlayerTurns: 9 });
  return (await store.listSuspensions(sessionId))[0]!;
}

describe("resume context", () => {
  it("hands an agent's tools the source turn's locale, clock and World Model", async () => {
    const store = await seededStore();
    const observed: Record<string, unknown>[] = [];
    const probe = tool({
      name: "probe-context",
      description: "Read execution context",
      parameters: z.strictObject({}),
      execute: async (_params, ctx) => {
        const seen = {
          locale: ctx.locale,
          logicalTurn: ctx.logicalTurn,
          turnNumber: ctx.turnNumber,
          characters: ctx.world?.characters.map((entry) => entry.name),
        };
        observed.push(seen);
        return seen;
      },
    });
    const modules = [probe, suspendTool, worldDimensionListTool];
    const toolExecutor = createToolExecutor({
      store,
      findTool: (name) => modules.find((module) => module.name === name),
      getToolSource: () => "builtin",
    });
    const manifest: RuntimeManifest = {
      name: "probe/agent",
      pluginId: "probe",
      runtimeType: "agent",
      stage: "narrative",
      outputKind: "plugin",
      trigger: { type: "auto" },
      tools: { builtin: ["probe-context", "world-dimension-list", "suspend"] },
      maxRetries: 0,
    };
    const usage = { inputTokens: 1, outputTokens: 1 };
    const requestedLocales: (string | undefined)[] = [];
    let calls = 0;
    const deps = {
      store,
      toolExecutor,
      loadRuntime: async (runtime: RuntimeManifest, locale?: string) => {
        requestedLocales.push(locale);
        return { manifest: runtime, promptTemplate: "Probe." };
      },
      llm: {
        generate: async () => {
          calls += 1;
          if (calls === 1)
            return {
              content: "",
              toolCalls: [
                { id: "probe-before", name: "probe-context", arguments: "{}" },
                {
                  id: "suspend",
                  name: "suspend",
                  arguments: JSON.stringify({
                    reason: "Confirm",
                    resumeSchema: { type: "object" },
                  }),
                },
              ],
              finishReason: "tool_calls" as const,
              usage,
            };
          if (calls === 2)
            return {
              content: "",
              toolCalls: [
                { id: "probe-after", name: "probe-context", arguments: "{}" },
                {
                  id: "dimensions-after",
                  name: "world-dimension-list",
                  arguments: "{}",
                },
              ],
              finishReason: "tool_calls" as const,
              usage,
            };
          return {
            content: JSON.stringify({ completed: true }),
            toolCalls: [],
            finishReason: "stop" as const,
            usage,
          };
        },
      },
    };

    try {
      const suspension = await suspendThenAdvance(
        store,
        await executeTurn(turnInput, [manifest], deps),
      );
      const resumed = await resumeSuspendedRuntime(
        suspension,
        {},
        manifest,
        deps,
      );

      expect(resumed.result.status).toBe("success");
      expect(observed).toHaveLength(2);
      expect(observed[0]).toEqual({
        locale: "zh-CN",
        logicalTurn: 4,
        turnNumber: 0,
        characters: ["Keeper"],
      });
      // The session counted six more turns; the continuation did not move.
      expect(observed[1]).toEqual(observed[0]);
      expect(requestedLocales).toEqual(["zh-CN", "zh-CN"]);
      const dimensions = resumed.result.toolCalls.find(
        (call) => call.toolCallId === "dimensions-after",
      );
      expect(dimensions?.output).toMatchObject({ dimensions: [] });
    } finally {
      await toolExecutor.close();
    }
  });

  it("hands a function handler the source turn's locale and logical turn", async () => {
    const store = await seededStore();
    const observed: Record<string, unknown>[] = [];
    const manifest: RuntimeManifest = {
      name: "probe/function",
      pluginId: "probe",
      runtimeType: "function",
      stage: "narrative",
      outputKind: "plugin",
      trigger: { type: "auto" },
    };
    const requestedLocales: (string | undefined)[] = [];
    const deps = {
      store,
      llm: {
        generate: async () => {
          throw new Error("Function runtimes do not use the LLM");
        },
      },
      loadRuntime: async (
        runtime: RuntimeManifest,
        locale?: string,
      ): Promise<LoadedRuntime> => {
        requestedLocales.push(locale);
        return {
          manifest: runtime,
          promptTemplate: "",
          messages: [{ locale: "zh-CN", messages: { Confirm: "确认" } }],
          handler: async (ctx) => {
            observed.push({
              locale: ctx.locale,
              logicalTurn: ctx.logicalTurn,
              translation: ctx.messages?.translations.Confirm,
              characters: ctx.world?.characters.map((entry) => entry.name),
            });
            return ctx.resumeData === undefined
              ? {
                  outcome: "suspended",
                  reason: "Confirm",
                  resumeSchema: { type: "object" },
                }
              : { outcome: "success", value: { done: true } };
          },
        };
      },
    };

    const suspension = await suspendThenAdvance(
      store,
      await executeTurn(turnInput, [manifest], deps),
    );
    const resumed = await resumeSuspendedRuntime(
      suspension,
      {},
      manifest,
      deps,
    );

    expect(resumed.result.status).toBe("success");
    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual({
      locale: "zh-CN",
      logicalTurn: 4,
      translation: "确认",
      characters: ["Keeper"],
    });
    expect(observed[1]).toEqual(observed[0]);
    expect(requestedLocales).toEqual(["zh-CN", "zh-CN"]);
  });
});

describe("resume completion evidence", () => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  const call = (id: string, name: string, args: unknown = {}) => ({
    id,
    name,
    arguments: JSON.stringify(args),
  });
  const suspend = call("suspend", "suspend", {
    reason: "Confirm",
    resumeSchema: { type: "object" },
  });

  /**
   * A `requireToolUse` agent whose first step calls `save-work` and suspends.
   * `workResults` says whether each `save-work` call succeeds; `afterResume`
   * lists the tool calls the model makes once resumed, before it answers.
   */
  async function resumeAfterWork(
    workResults: readonly boolean[],
    afterResume: readonly ReturnType<typeof call>[] = [],
  ) {
    const store = await seededStore();
    let workCalls = 0;
    const saveWork = tool({
      name: "save-work",
      description: "Save the required work",
      parameters: z.strictObject({}),
      execute: async () => {
        const succeeds = workResults[workCalls];
        workCalls += 1;
        if (!succeeds) throw new Error("write failed");
        return { saved: true };
      },
    });
    const modules = [saveWork, suspendTool, runtimeDoneTool];
    const toolExecutor = createToolExecutor({
      store,
      findTool: (name) => modules.find((module) => module.name === name),
      getToolSource: () => "builtin",
    });
    const manifest: RuntimeManifest = {
      name: "probe/required-work",
      pluginId: "probe",
      runtimeType: "agent",
      stage: "narrative",
      outputKind: "plugin",
      trigger: { type: "auto" },
      tools: { builtin: ["save-work", "suspend", "runtime-done"] },
      requireToolUse: true,
      maxRetries: 0,
    };
    let modelCalls = 0;
    const deps = {
      store,
      toolExecutor,
      loadRuntime: async (runtime: RuntimeManifest) => ({
        manifest: runtime,
        promptTemplate: "Do the required work.",
      }),
      llm: {
        generate: async () => {
          modelCalls += 1;
          const toolCalls =
            modelCalls === 1
              ? [call("work", "save-work"), suspend]
              : modelCalls === 2
                ? afterResume
                : [];
          return toolCalls.length > 0
            ? {
                content: "",
                toolCalls: [...toolCalls],
                finishReason: "tool_calls" as const,
                usage,
              }
            : {
                content: JSON.stringify({ completed: true }),
                toolCalls: [],
                finishReason: "stop" as const,
                usage,
              };
        },
      },
    };
    try {
      const suspension = await suspendThenAdvance(
        store,
        await executeTurn(turnInput, [manifest], deps),
      );
      const resumed = await resumeSuspendedRuntime(
        suspension,
        {},
        manifest,
        deps,
      );
      return { result: resumed.result, workCalls };
    } finally {
      await toolExecutor.close();
    }
  }

  it("does not count a tool that failed before the suspension as the required work", async () => {
    const { result, workCalls } = await resumeAfterWork([false]);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("requireToolUse");
    expect(workCalls).toBe(1);
  });

  it("counts a tool that succeeded before the suspension, without calling it again", async () => {
    const { result, workCalls } = await resumeAfterWork([true]);
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({ completed: true });
    expect(workCalls).toBe(1);
  });

  it("completes when the resumed runtime repeats the failed tool and it succeeds", async () => {
    const { result, workCalls } = await resumeAfterWork(
      [false, true],
      [call("retry", "save-work")],
    );
    expect(result.status).toBe("success");
    expect(workCalls).toBe(2);
  });

  // `runtime-done` leaves the loop through its own exit, which must read the
  // same evidence as a text answer.
  const done = call("done", "runtime-done", { reason: "finished" });

  it("does not let runtime-done stand in for a tool that failed before the suspension", async () => {
    const { result, workCalls } = await resumeAfterWork([false], [done]);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("requireToolUse");
    expect(workCalls).toBe(1);
  });

  it("accepts runtime-done after a tool that succeeded before the suspension", async () => {
    const { result, workCalls } = await resumeAfterWork([true], [done]);
    expect(result.status).toBe("success");
    expect(workCalls).toBe(1);
  });

  it("accepts runtime-done once the resumed runtime has repeated the failed tool successfully", async () => {
    const { result, workCalls } = await resumeAfterWork(
      [false, true],
      [call("retry", "save-work"), done],
    );
    expect(result.status).toBe("success");
    expect(workCalls).toBe(2);
  });
});

// A loop can also end without an answer being checked: at its step limit, or
// when a PostToolUse hook stops it. The model's reply here carries a valid
// JSON output beside the tool call, so only the tool's outcome can tell
// whether the required work was done.
describe.each(["step limit", "hook stop"] as const)(
  "requireToolUse when the loop ends at the %s",
  (exit) => {
    async function run(suspended: boolean, succeeds: boolean) {
      const store = await seededStore();
      let workCalls = 0;
      const saveWork = tool({
        name: "save-work",
        description: "Save the required work",
        parameters: z.strictObject({}),
        execute: async () => {
          workCalls += 1;
          if (!succeeds) throw new Error("write failed");
          return { saved: true };
        },
      });
      const modules = [saveWork, suspendTool];
      const toolExecutor = createToolExecutor({
        store,
        findTool: (name) => modules.find((module) => module.name === name),
        getToolSource: () => "builtin",
      });
      const hookPipeline = createHookPipeline();
      hookPipeline.register({
        id: "stop-after-work",
        event: "PostToolUse",
        handler: async (_ctx, payload) => {
          const { toolCall } = payload as { toolCall: { id: string } };
          return exit === "hook stop" && toolCall.id === "last-work"
            ? { action: "continue", replace: { terminate: true } }
            : { action: "continue" };
        },
      });
      const manifest: RuntimeManifest = {
        name: "probe/required-work",
        pluginId: "probe",
        runtimeType: "agent",
        stage: "narrative",
        outputKind: "plugin",
        trigger: { type: "auto" },
        tools: { builtin: ["save-work", "suspend"] },
        requireToolUse: true,
        maxRetries: 0,
        ...(exit === "step limit" ? { maxSteps: 1 } : {}),
      };
      const usage = { inputTokens: 1, outputTokens: 1 };
      let modelCalls = 0;
      const deps = {
        store,
        hookPipeline,
        toolExecutor,
        loadRuntime: async (runtime: RuntimeManifest) => ({
          manifest: runtime,
          promptTemplate: "Do the required work.",
        }),
        llm: {
          generate: async () => {
            modelCalls += 1;
            return suspended && modelCalls === 1
              ? {
                  content: "",
                  toolCalls: [
                    { id: "first-work", name: "save-work", arguments: "{}" },
                    {
                      id: "suspend",
                      name: "suspend",
                      arguments: JSON.stringify({
                        reason: "Confirm",
                        resumeSchema: { type: "object" },
                      }),
                    },
                  ],
                  finishReason: "tool_calls" as const,
                  usage,
                }
              : {
                  content: JSON.stringify({ completed: true }),
                  toolCalls: [
                    { id: "last-work", name: "save-work", arguments: "{}" },
                  ],
                  finishReason: "tool_calls" as const,
                  usage,
                };
          },
        },
      };
      try {
        const execution = await executeTurn(turnInput, [manifest], deps);
        if (!suspended)
          return { result: execution.result.runtimeResults[0]!, workCalls };
        const suspension = await suspendThenAdvance(store, execution);
        const resumed = await resumeSuspendedRuntime(
          suspension,
          {},
          manifest,
          deps,
        );
        const outcome = await commitExecution({
          store,
          execution: resumed,
          completion: {
            kind: "resume",
            turnId: suspension.turnId,
            suspensionId: suspension.id,
            pluginId: manifest.pluginId,
            runtimeId: manifest.name,
          },
        });
        return {
          result: resumed.result,
          workCalls,
          commitStatus: outcome.status,
          resolvedAt: (await store.getSuspension(suspension.id))?.resolvedAt,
        };
      } finally {
        await toolExecutor.close();
      }
    }

    it("fails a run whose only business tool call failed", async () => {
      const { result, workCalls } = await run(false, false);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("requireToolUse");
      expect(workCalls).toBe(1);
    });

    it("accepts a run whose business tool call succeeded", async () => {
      const { result, workCalls } = await run(false, true);
      expect(result.status).toBe("success");
      expect(workCalls).toBe(1);
    });

    it("fails a resumed run whose tool calls all failed and leaves its suspension open", async () => {
      const { result, workCalls, commitStatus, resolvedAt } = await run(
        true,
        false,
      );
      expect(result.status).toBe("failed");
      expect(result.error).toContain("requireToolUse");
      expect(workCalls).toBe(2);
      expect(commitStatus).toBe("failed");
      expect(resolvedAt).toBeUndefined();
    });

    it("accepts a resumed run whose tool calls succeeded and resolves its suspension", async () => {
      const { result, workCalls, commitStatus, resolvedAt } = await run(
        true,
        true,
      );
      expect(result.status).toBe("success");
      expect(workCalls).toBe(2);
      expect(commitStatus).toBe("committed");
      expect(resolvedAt).toBeDefined();
    });
  },
);
