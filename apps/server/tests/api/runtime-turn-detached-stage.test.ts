import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import type { FunctionHandler, LoadedRuntime } from "@covel/plugin-loader";
import type {
  DeferredRuntimeJob,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import { createMemoryStore } from "@covel/store";

import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createPluginRpcRuntimeTurnRunner } from "../../src/routes/api/plugin-rpc/runtime-turn.js";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../../src/routes/api/session/session-guard.js";

const SESSION_ID = "detached-runner-session";
const PLUGIN_ID = "detached-runner";
const PRODUCER_ID = `${PLUGIN_ID}/producer`;
const RUNTIME_ID = `${PLUGIN_ID}/leaf`;

function manifest(): RuntimeManifest {
  return {
    name: RUNTIME_ID,
    pluginId: PLUGIN_ID,
    description: "safe detached leaf",
    version: "1.0.0",
    runtimeType: "function",
    handler: "./handler.js",
    stage: "post-turn",
    trigger: { type: "auto" },
    inputs: {
      narrative: {
        from: { runtime: PRODUCER_ID },
        select: "/narrativeOutput",
        required: true,
      },
    },
    needs: [PRODUCER_ID],
    effects: { writes: ["plugin-data:self:tracks"] },
    turnCompletion: { mode: "detached" },
  };
}

function producerManifest(): RuntimeManifest {
  return {
    name: PRODUCER_ID,
    pluginId: PLUGIN_ID,
    description: "source provider",
    version: "1.0.0",
    runtimeType: "function",
    handler: "./producer.js",
    stage: "narrative",
    trigger: { type: "auto" },
  };
}

function sourceResult(): RuntimeResult {
  return {
    pluginId: PLUGIN_ID,
    runtimeId: PRODUCER_ID,
    runId: "source-run",
    turnId: "source-turn",
    status: "success",
    output: { narrativeOutput: "frozen source output" },
    toolCalls: [],
    durationMs: 1,
    timestamp: "2026-09-03T00:00:00.000Z",
  };
}

function descriptor(): DeferredRuntimeJob {
  return {
    jobId: "runtime-job",
    runtimeId: RUNTIME_ID,
    pluginId: PLUGIN_ID,
    sourceTurnId: "source-turn",
    sourceExecutionId: "source-execution",
    sourceExecutionStartedAt: "2026-09-03T00:00:00.000Z",
    pluginVersion: "1.0.0",
    upstreamResults: [sourceResult()],
  };
}

describe("plugin RPC detached-stage runner", () => {
  async function setup(handler: FunctionHandler) {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: SESSION_ID,
      status: "active",
      locale: "zh-CN",
      phase: "playing",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      activePlugins: [PLUGIN_ID],
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });
    const session = (await store.getSession(SESSION_ID))!;
    const runtimeManifest = manifest();
    const loaded: LoadedRuntime = {
      manifest: runtimeManifest,
      promptTemplate: "",
      handler,
    };
    const eventBus = createEventBus(store);
    const observed: string[] = [];
    eventBus.onEmit((event) => observed.push(event.type));
    const runner = createPluginRpcRuntimeTurnRunner({
      store,
      eventBus,
      sessionLock: createInProcessSessionLock(),
      sessionId: SESSION_ID,
      session,
      activeRuntimes: [producerManifest(), runtimeManifest],
      approvalScopes: new Map([
        [PLUGIN_ID, sessionApprovalScope(session, PLUGIN_ID)],
      ]),
      deps: {
        loadRuntime: async () => loaded,
        // Function runtimes do not call the LLM adapter.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        llm: { generate: async () => ({}) } as any,
      },
    });
    return { store, session, runner, observed };
  }

  it("rehydrates frozen inputs, commits output, and does not complete a player turn", async () => {
    const handler: FunctionHandler = async (ctx) => {
      const narrative = ctx.inputs?.narrative as
        { value?: unknown } | undefined;
      return {
        outcome: "success",
        value: {},
        effects: {
          pluginData: [
            {
              namespace: "tracks",
              key: "track-1",
              value: { source: narrative?.value },
            },
          ],
        },
      };
    };
    const { store, session, runner, observed } = await setup(handler);
    const beforeCommit = vi.fn(async () => {});

    const outcome = await runner.runDetachedStage({
      descriptor: descriptor(),
      backgroundTurnId: "background-turn",
      expectedSessionIncarnation: sessionIncarnationIdentity(session),
      beforeCommit,
    });

    expect(outcome.commit.committed).toBe(true);
    expect(beforeCommit).toHaveBeenCalledWith({
      backgroundTurnId: "background-turn",
      backgroundExecutionId: expect.any(String),
    });
    await expect(
      store.getPluginData(SESSION_ID, PLUGIN_ID, "tracks", "track-1"),
    ).resolves.toMatchObject({
      value: { source: "frozen source output" },
    });
    expect(observed).not.toContain("turn.completed");
  });

  it("rejects an undeclared effect before any domain proposal commits", async () => {
    const { store, session, runner } = await setup(async () => ({
      outcome: "success",
      value: {},
      effects: {
        pluginData: [
          { namespace: "undeclared", key: "row", value: { unsafe: true } },
        ],
      },
    }));

    const outcome = await runner.runDetachedStage({
      descriptor: descriptor(),
      backgroundTurnId: "background-turn-guarded",
      expectedSessionIncarnation: sessionIncarnationIdentity(session),
      beforeCommit: async () => {},
    });

    expect(outcome.commit).toMatchObject({
      committed: false,
      failedProposalCount: 1,
    });
    await expect(
      store.listPluginData(SESSION_ID, PLUGIN_ID, "undeclared"),
    ).resolves.toEqual([]);
  });
});
