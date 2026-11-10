/**
 * A background job run with services a request handed over passes them on
 * to the stage jobs its commit queues: inside the commit transaction, so the
 * worker never claims one without them, and withdrawn when the commit does
 * not land.
 */

import { describe, expect, it } from "vitest";
import { createEventBus } from "@covel/events";
import type { LLMAdapter } from "@covel/runtime";
import type {
  DeferredRuntimeJob,
  RuntimeManifest,
  TurnResult,
} from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeJobRecord } from "../../src/routes/api/plugin-rpc/jobs.js";
import {
  createRuntimeJobCredentials,
  type RuntimeJobCredentialKey,
  type RuntimeJobServices,
} from "../../src/routes/api/plugin-rpc/runtime-job-credentials.js";
import { NO_FOLLOW_UPS } from "../../src/routes/api/commit-envelope.js";
import { createRuntimeJobExecutor } from "../../src/routes/api/plugin-rpc/runtime-job-executor.js";
import type { RunManualTurnArgs } from "../../src/routes/api/plugin-rpc/runtime-turn.js";
import type { RuntimeJobExecutionControl } from "../../src/routes/api/plugin-rpc/runtime-job-worker.js";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../../src/routes/api/session/session-guard.js";

const PLUGIN_ID = "executor-handoff-probe";
const SESSION_ID = "executor-handoff-session";
const NOW = "2026-11-09T00:00:00.000Z";

const target = {
  name: "recap",
  pluginId: PLUGIN_ID,
  description: "test function runtime",
  runtimeType: "function",
  outputKind: "system",
  handler: "./handler.js",
  trigger: { type: "manual" },
} as RuntimeManifest;

const stageJob: DeferredRuntimeJob = {
  jobId: "stage-job",
  runtimeId: target.name,
  pluginId: PLUGIN_ID,
  sourceTurnId: "turn-1",
  sourceExecutionId: "execution-1",
  sourceExecutionStartedAt: NOW,
  turnDigest: {
    turnId: "turn-1",
    playerMessage: "",
    actions: [],
    lastPlayerInput: null,
    narrativeText: "",
    toolCallSummaries: [],
    runtimeResults: [],
  },
  upstreamResults: [],
};

async function setup() {
  const store = createMemoryStore();
  await store.createSession({
    id: SESSION_ID,
    worldId: "world",
    status: "active",
    phase: "playing",
    locale: "en-US",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [PLUGIN_ID],
    metadata: {
      approvalScopeNonce: "approval",
      sessionIncarnationNonce: "incarnation",
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const session = (await store.getSession(SESSION_ID))!;
  const expectedSessionIncarnation = sessionIncarnationIdentity(session);
  const job: RuntimeJobRecord = {
    schemaVersion: 1,
    jobId: "manual-job",
    sessionId: SESSION_ID,
    pluginId: PLUGIN_ID,
    runtimeId: target.name,
    status: "running",
    origin: { activation: "manual", sourceTurnId: "turn-0" },
    payload: {
      schemaVersion: 1,
      activation: "manual",
      turnId: "turn-1",
      expectedSessionIncarnation,
      expectedApprovalScope: sessionApprovalScope(session, PLUGIN_ID),
      locale: "en-US",
    },
    enqueuedAt: NOW,
    updatedAt: NOW,
    attempt: 1,
    sequence: 1,
  } as RuntimeJobRecord;
  const stageKey: RuntimeJobCredentialKey = {
    jobId: stageJob.jobId,
    sessionId: SESSION_ID,
    expectedSessionIncarnation,
  };
  return { store, job, stageKey };
}

const turnResult = {
  turnId: "turn-1",
  executionContext: { executionId: "execution-1" },
  durationMs: 1,
  runtimeResults: [],
  deferredRuntimeJobs: [stageJob],
} as unknown as TurnResult;

const control: RuntimeJobExecutionControl = {
  assertCurrent: async () => {},
  signal: new AbortController().signal,
  executionFinished: () => {},
  beforeCommit: async () => {},
  completeInTx: async () => {},
  failInTx: async () => {},
};

/** Run the manual job, committing its turn and reporting `committed`. */
async function runJob(committed: boolean) {
  const { store, job, stageKey } = await setup();
  const credentials = createRuntimeJobCredentials();
  const services: RuntimeJobServices = { llm: {} as LLMAdapter };
  let handedInTx: RuntimeJobServices | undefined;
  const execute = createRuntimeJobExecutor({
    store,
    eventBus: createEventBus(),
    registry: {
      syncSessionActivations: () => {},
      getActiveRuntimes: () => [target],
    },
    credentials,
    createRunner: () =>
      ({
        // The runner's commit: follow-ups, then the job's own completion.
        runManualTurn: async (args: RunManualTurnArgs) => {
          const isolation = { droppedRuntimeIds: new Set<string>() };
          const queued = await store.withTransaction(async (tx) => {
            const followUps = await args.followUps(tx, turnResult, isolation);
            await args.completeInTx?.(tx, turnResult, isolation, followUps);
            handedInTx = credentials.peek(stageKey);
            return followUps;
          });
          return {
            commit: committed
              ? { committed: true, followUps: queued }
              : {
                  committed: false,
                  error: "commit refused",
                  followUps: NO_FOLLOW_UPS,
                },
          };
        },
      }) as never,
  })(services, true);
  const outcome = execute(job, control);
  return { outcome, credentials, stageKey, services, handed: () => handedInTx };
}

describe("runtime job executor credential hand-off", () => {
  it("hands services to the stage jobs its commit queues inside the transaction", async () => {
    const { outcome, credentials, stageKey, services, handed } =
      await runJob(true);
    await outcome;
    expect(handed()).toBe(services);
    expect(credentials.peek(stageKey)).toBe(services);
  });

  it("withdraws them when the commit does not land", async () => {
    const { outcome, credentials, stageKey, services, handed } =
      await runJob(false);
    await expect(outcome).rejects.toThrow("commit refused");
    expect(handed()).toBe(services);
    expect(credentials.peek(stageKey)).toBeUndefined();
  });
});
