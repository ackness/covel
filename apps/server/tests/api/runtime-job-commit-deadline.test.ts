/**
 * A durable runtime job's `maxExecutionMs` bounds the runtime's own work. The
 * wait for the session lock to commit is not execution: a player turn the
 * settle barrier admitted after its timeout may hold that lock for minutes.
 */

import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type FunctionHandler,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  createRuntimeJob,
  getRuntimeJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../../src/routes/api/session/session-guard.js";
import { createTestRuntimeJobWorker } from "./__helpers/runtime-job-worker.js";

const SESSION_ID = "deadline-session";
const PLUGIN_ID = "deadline-plugin";
const STAGE_RUNTIME = `${PLUGIN_ID}/extract`;
const MANUAL_RUNTIME = `${PLUGIN_ID}/render`;
const MAX_EXECUTION_MS = 200;
const JOB_KEY = { sessionId: SESSION_ID, pluginId: PLUGIN_ID, jobId: "job" };

type Activation = "stage" | "manual";

function manifest(
  name: string,
  extra: Partial<RuntimeManifest>,
): RuntimeManifest {
  return {
    name,
    pluginId: PLUGIN_ID,
    description: "fixture",
    version: "1.0.0",
    runtimeType: "function",
    outputKind: "system",
    pluginType: "plugin",
    handler: "./handler.js",
    effects: { writes: ["plugin-data:self:tracks"] },
    ...extra,
  } as RuntimeManifest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function setup(handler: FunctionHandler) {
  const store = createMemoryStore();
  const eventBus = createEventBus(store);
  const sessionLock = createInProcessSessionLock();
  const runtimes = new Map<string, LoadedRuntime>(
    [
      manifest(STAGE_RUNTIME, {
        stage: "post-turn",
        trigger: { type: "auto" },
        turnCompletion: { mode: "detached" },
      }),
      manifest(MANUAL_RUNTIME, { trigger: { type: "manual" } }),
    ].map((runtime) => [
      runtime.name,
      { manifest: runtime, promptTemplate: "", handler },
    ]),
  );
  const pluginRegistry = createPluginRegistry();
  pluginRegistry.register({
    id: PLUGIN_ID,
    summary: {
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      description: "",
      pluginType: "plugin",
      runtimeCount: runtimes.size,
    },
    manifests: [...runtimes.values()].map((loaded) => ({
      runtime: { type: "function" as const },
      manifest: loaded.manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    })),
    loadedRuntimes: runtimes,
    status: "registered",
    source: "builtin",
  } as PluginRegistryEntry);
  const now = new Date().toISOString();
  await store.createSession({
    id: SESSION_ID,
    status: "active",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    locale: "en-US",
    activePlugins: [PLUGIN_ID],
    metadata: {
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
    },
    createdAt: now,
    updatedAt: now,
  });
  const worker = createTestRuntimeJobWorker({
    store,
    eventBus,
    sessionLock,
    pluginRegistry,
    deps: {
      loadRuntime: async (m: RuntimeManifest) => runtimes.get(m.name),
      llm: {
        generate: async () => {
          throw new Error("function runtimes do not use the LLM");
        },
      },
    },
  });

  const enqueue = async (activation: Activation) => {
    const session = (await store.getSession(SESSION_ID))!;
    const admitted = {
      schemaVersion: 1,
      expectedSessionIncarnation: sessionIncarnationIdentity(session),
      expectedApprovalScope: sessionApprovalScope(session, PLUGIN_ID),
      locale: session.locale,
    } as const;
    await createRuntimeJob(store, {
      ...JOB_KEY,
      runtimeId: activation === "stage" ? STAGE_RUNTIME : MANUAL_RUNTIME,
      origin: { activation, sourceTurnId: "source-turn" },
      maxExecutionMs: MAX_EXECUTION_MS,
      payload:
        activation === "stage"
          ? {
              ...admitted,
              descriptor: {
                jobId: JOB_KEY.jobId,
                pluginId: PLUGIN_ID,
                runtimeId: STAGE_RUNTIME,
                pluginVersion: "1.0.0",
                sourceTurnId: "source-turn",
                sourceExecutionId: "source-execution",
                sourceExecutionStartedAt: now,
                turnDigest: {
                  turnId: "source-turn",
                  playerMessage: "",
                  lastPlayerInput: null,
                  narrativeText: "",
                  toolCallSummaries: [],
                  runtimeResults: [],
                },
                upstreamResults: [],
              },
            }
          : { ...admitted, activation: "manual", turnId: "manual-turn" },
    });
    worker.wake();
  };

  /** Take the session lock as a foreground turn would; resolves once held. */
  const holdSessionLock = async () => {
    let release: (() => void) | undefined;
    const held = sessionLock.withLock(
      SESSION_ID,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    return async () => {
      release!();
      await held;
    };
  };

  return { store, worker, enqueue, holdSessionLock };
}

function gatedHandler() {
  let started!: () => void;
  let proceed!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const proceedPromise = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const handler: FunctionHandler = async () => {
    started();
    await proceedPromise;
    return {
      outcome: "success",
      value: {},
      effects: {
        pluginData: [{ namespace: "tracks", key: "row", value: { done: 1 } }],
      },
    };
  };
  return { handler, started: startedPromise, proceed };
}

describe("runtime job execution deadline", () => {
  it.each(["stage", "manual"] as const)(
    "does not bill the wait for the session commit lock to a %s job",
    async (activation) => {
      const gate = gatedHandler();
      const f = await setup(gate.handler);
      await f.enqueue(activation);
      await gate.started;
      // A foreground turn takes the session lock while the runtime works,
      // then the runtime returns and its commit queues behind that turn.
      const endTurn = await f.holdSessionLock();
      gate.proceed();
      try {
        const running = await getRuntimeJob(f.store, JOB_KEY);
        await sleep(
          Date.parse(running!.startedAt!) + 2 * MAX_EXECUTION_MS - Date.now(),
        );
        expect(await getRuntimeJob(f.store, JOB_KEY)).toMatchObject({
          status: "running",
        });
      } finally {
        await endTurn();
      }
      await vi.waitFor(async () =>
        expect(await getRuntimeJob(f.store, JOB_KEY)).toMatchObject({
          status: "succeeded",
        }),
      );
      expect(
        (await f.store.getPluginData(SESSION_ID, PLUGIN_ID, "tracks", "row"))
          ?.value,
      ).toEqual({ done: 1 });
    },
  );

  it("still times out a runtime that outlives the deadline, and commits nothing", async () => {
    const gate = gatedHandler();
    const f = await setup(gate.handler);
    await f.enqueue("stage");
    await gate.started;
    await vi.waitFor(async () =>
      expect(await getRuntimeJob(f.store, JOB_KEY)).toMatchObject({
        status: "timed_out",
        reason: "execution-deadline-exceeded",
      }),
    );
    gate.proceed();
    // close() waits for the late execution to finish its commit attempt.
    await f.worker.close();
    expect(
      await f.store.getPluginData(SESSION_ID, PLUGIN_ID, "tracks", "row"),
    ).toBeFalsy();
  });
});
