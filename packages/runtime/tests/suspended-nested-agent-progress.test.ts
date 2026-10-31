/**
 * A nested agent whose guard reports progress and that then suspends keeps the
 * scope its guard's task reports under (the root execution's), so resume and
 * abandon settle that task instead of leaving it waiting for input.
 */

import { describe, expect, it } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import { createMemoryStore } from "@covel/store/memory";
import { suspendTool } from "@covel/tools";
import {
  applySuspensionAbandonTx,
  commitExecution,
  executeTurn,
  planSuspensionAbandon,
  resumeSuspendedRuntime,
  settleAbandonedSuspensionJobs,
} from "../src/index.js";
import type { ExecutionDeps } from "../src/execution.js";
import {
  makeExecutor,
  prose,
  queuedLLM,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

const SESSION = "session";
const timestamp = "2026-10-30T00:00:00.000Z";
const input = {
  sessionId: SESSION,
  turnId: "turn",
  logicalTurnId: "logical-turn",
  playerMessage: "Continue",
  origin: "player" as const,
};
const ASK = {
  reason: "Need input",
  fields: [{ type: "text", name: "answer", label: "Answer" }],
};

const parent: RuntimeManifest = {
  name: "probe/parent",
  pluginId: "probe",
  description: "parent",
  runtimeType: "function",
  stage: "narrative",
  outputKind: "system",
  trigger: { type: "auto" },
};
const asker: RuntimeManifest = {
  name: "probe/asker",
  pluginId: "probe",
  description: "asker",
  runtimeType: "agent",
  stage: "narrative",
  outputKind: "system",
  trigger: { type: "manual" },
  tools: { builtin: ["suspend"] },
};
const runtimes = [parent, asker];

const callAsker: FunctionHandler = async (ctx) => {
  await ctx.recursiveCall({ manualTrigger: { runtimeId: asker.name } });
  return { outcome: "success", value: {} };
};

function depsFor(
  store: ReturnType<typeof createMemoryStore>,
  replies: Parameters<typeof queuedLLM>[0],
): ExecutionDeps {
  return {
    store,
    llm: queuedLLM(replies),
    toolExecutor: makeExecutor([suspendTool]),
    loadRuntime: async (manifest) =>
      manifest.name === asker.name
        ? {
            manifest,
            promptTemplate: "Ask.",
            // Reports a task, then lets the agent run.
            guard: async (ctx: {
              progress?: {
                report(update: {
                  jobId: string;
                  state: "running";
                  sequence: number;
                }): Promise<void>;
              };
            }) => {
              await ctx.progress?.report({
                jobId: "guard-job",
                state: "running",
                sequence: 1,
              });
              return {};
            },
          }
        : { manifest, promptTemplate: "", handler: callAsker },
  } as ExecutionDeps;
}

async function suspendedAgent() {
  const store = createMemoryStore();
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["probe"],
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const execution = await executeTurn(
    input,
    runtimes,
    depsFor(store, [toolCall("suspend", ASK)]),
  );
  expect(
    (
      await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      })
    ).status,
  ).toBe("committed");
  const [suspension] = await store.listSuspensions(SESSION);
  expect(suspension?.runtimeId).toBe(asker.name);
  const scope = execution.commit.executionContext.executionId;
  const states = async () =>
    (
      await store.listJobStatus(SESSION, {
        progressScopeId: scope,
        jobId: "guard-job",
      })
    ).map((record) => record.state);
  return { store, suspension: suspension!, scope, states };
}

describe("progress of a nested agent that suspends", () => {
  it("keeps the root execution's scope apart from its own execution identity", async () => {
    const { suspension, scope, states } = await suspendedAgent();
    expect(suspension.pendingContinuation.progressScopeId).toBe(scope);
    expect(
      suspension.pendingContinuation.executionContext.executionId,
    ).not.toBe(scope);
    expect(await states()).toEqual(["running", "waiting-input"]);
  });

  it("settles the guard's task with the agent's resume", async () => {
    const { store, suspension, states } = await suspendedAgent();
    expect(await store.claimSuspension(suspension.id)).not.toBeNull();
    const resumed = await resumeSuspendedRuntime(
      suspension,
      {},
      asker,
      depsFor(store, [prose("All answered.")]),
      { activeRuntimes: runtimes },
    );
    expect(resumed.result.status).toBe("success");
    expect(
      (
        await commitExecution({
          store,
          execution: structuredClone(resumed),
          completion: {
            kind: "resume",
            turnId: suspension.turnId,
            suspensionId: suspension.id,
            pluginId: suspension.pluginId,
            runtimeId: suspension.runtimeId,
          },
        })
      ).status,
    ).toBe("committed");
    expect(await states()).toEqual(["running", "waiting-input", "succeeded"]);
  });

  it("cancels the guard's task when the suspension is abandoned, and only once", async () => {
    const { store, suspension, states } = await suspendedAgent();
    const plan = await planSuspensionAbandon(store, suspension);
    await store.withTransaction((tx) =>
      applySuspensionAbandonTx(tx, plan, timestamp),
    );
    await settleAbandonedSuspensionJobs({ store }, suspension);
    const cancelled = ["running", "waiting-input", "cancelled"];
    expect(await states()).toEqual(cancelled);
    await settleAbandonedSuspensionJobs({ store }, suspension);
    expect(await states()).toEqual(cancelled);
  });
});
